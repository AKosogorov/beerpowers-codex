use strict;
use warnings;
use utf8;

use Fcntl qw(O_CREAT O_EXCL O_WRONLY);
use Time::HiRes ();

sub screenshot_task {
    my ($root, $dir) = @_;
    my $tasks = "$root/memory/tasks";
    my $code = qr/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*/;
    my $scoped = index($dir, "$tasks/") == 0 || index($dir, "$root/worktrees/") == 0;
    my @matches;
    while (index($dir, "$tasks/") == 0) {
        push @matches, $dir if $dir =~ m{\A\Q$tasks\E/$code\z}
            && grep { -f "$dir/$_" } qw(preflight.md checkouts.json git-flow.md test-cases.md);
        $dir = dirname($dir);
    }
    return @matches == 1 ? $matches[0] : '' if @matches;

    while (index($dir, "$root/worktrees/") == 0) {
        if (-e "$dir/.git" && $dir =~ m{\A\Q$root\E/worktrees/($code)/[^/]+\z}) {
            my $task = "$tasks/$1";
            return -d $task && path_at($root, $task) eq $task ? $task : '';
        }
        $dir = dirname($dir);
    }
    return $scoped ? '' : undef;
}
sub fresh_tester_screenshot {
    my ($root, $task, $since) = @_;
    my $dir = "$task/screenshots";
    return 0 unless -d $dir && path_at($root, $dir) eq $dir;
    opendir my $dh, $dir or return 0;
    while (defined(my $name = readdir $dh)) {
        next unless $name =~ /\Atester-.+\.(?:png|jpe?g|webp)\z/i;
        my $file = "$dir/$name";
        next if -l $file || !-f $file;
        my @info = Time::HiRes::stat($file);
        return 1 if @info && $info[9] >= $since;
    }
    return 0;
}
sub screenshots_reminder {
    my ($event, $json, $root, $cwd, $stop, $message) = @_;
    if (($event->{agent_type} // '') !~ /\A(?:tester|testing-agent)\z/) {
        my $note = 'Если бриф этой роли — тестирование экранов, проверь свежие tester-* в screenshots/ задачи или объяснение в отчёте.';
        context($note) unless $stop;
        emit({systemMessage => "$message $note"});
    }

    my $id = $event->{agent_id};
    my $start = $id ? state_file('screenshots', $id) : undef;
    my $cwd_task = screenshot_task($root, $cwd);
    my $omission = 'Если снимков нет, укажи причину в отчёте и повтори её отдельной строкой «Скриншоты не приложены: <причина>» в итоговом сообщении.';
    unless ($stop) {
        remember($start, $json->encode({task => $cwd_task, since => Time::HiRes::time()}));
        context("При проверке экранов сохрани снимки tester-* в screenshots/ задачи и опиши увиденное. $omission");
    }

    my $started = $start && -f $start ? eval { $json->decode(raw_file($start)) } : undef;
    my $task = ref $started eq 'HASH' ? $started->{task} : undef;
    my $since = ref $started eq 'HASH' ? $started->{since} : undef;
    unless (defined $since && $since =~ /\A[0-9]+(?:\.[0-9]+)?\z/
        && defined $task && index($task, "$root/memory/tasks/") == 0 && -d $task
        && path_at($root, $task) eq $task && (!defined $cwd_task || $cwd_task eq $task)) {
        emit({systemMessage => "$message Не удалось однозначно связать тестера с задачей. Проверь свежие tester-* в screenshots/ текущей задачи или причину их отсутствия в отчёте."});
    }

    my $report = $event->{last_assistant_message} // '';
    my $explained = $report =~ /^[ \t]*(?:Скриншоты не приложены|Screenshots omitted):[ \t]*\S[^\r\n]*\r?$/mi;
    my $reminded = state_file('screenshots-shown', $id, $task, $since);
    if (!$event->{stop_hook_active} && !$explained && !-e $reminded && !fresh_tester_screenshot($root, $task, $since)
        && sysopen(my $marker, $reminded, O_CREAT | O_EXCL | O_WRONLY, 0600)) {
        close $marker;
        emit({decision => 'block', reason => "Приложи снимки текущей проверки. $omission", systemMessage => $message});
    }
}

1;
