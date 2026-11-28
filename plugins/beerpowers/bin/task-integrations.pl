# Передаёт команды интеграций задачи адаптеру Node из внешнего workspace.
use strict;
use warnings;
use Fcntl qw(:flock);

# Legacy task-start retains its journal and its offline, read-only entry point.
sub run_integrated_task {
    my ($mode, @args) = @_;
    my $node = $ENV{BEERPOWERS_NODE} || 'node';
    my $script = File::Basename::dirname(__FILE__) . '/task-integrations.mjs';
    if ($^O eq 'cygwin') {
        $node = Cygwin::win_to_posix_path($node) if $node =~ /^[A-Za-z]:/;
        $script = Cygwin::posix_to_win_path($script);
    }
    system {$node} $node, $script, $mode, @args;
    die "Integrated task failed; check the preceding error and BEERPOWERS_NODE\n" if $? != 0;
    return 1;
}

sub stage_seven_task {
    my ($product, $mode, @args) = @_;
    my $cfg = parse_json(read_file('.codex/git-settings.json'))->{repos};
    my ($code) = @args;
    my $ordinary = @args == 1 || (@args == 2 && $args[1] eq '--preview');
    $ordinary &&= defined($code) && $code !~ /@|\A[A-Z][A-Z0-9_]*-[0-9]+\z/ &&
        keys(%$cfg) == 1 && (values %$cfg)[0] eq 'main-default' && !$ENV{BEERPOWERS_GIT_TASKS};
    if ($ordinary) {
        validate_task_name($code);
        my $dir = task_path("memory/tasks/$code");
        $ordinary = 0 if -f "$dir/checkouts.json" || -f "$dir/git-flow.md" || -d "$dir/tracker";
        $ordinary = 0 if -f "$dir/preflight.md" && markdown_prose(read_file("$dir/preflight.md")) =~ /^Base-SHA [\w.-]+:/m;
    }
    return 0 if $ordinary && !-e '.git/beerpowers-task-start-7.json';
    my $preview = 0;
    for (@args) {
        last if $_ eq '--';
        $preview = 1 if $_ eq '--preview';
    }
    my $lock;
    if ($mode eq 'task-start' && !$preview) {
        check_checkout('.');
        open $lock, '<', '.git/config' or die ".git/config: $!\n";
        flock($lock, LOCK_EX | LOCK_NB) or die "Another task update is active\n";
    }
    return run_integrated_task($mode, @args);
}
1;
