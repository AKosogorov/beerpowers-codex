use strict;
use warnings;
use utf8;
use JSON::PP ();
use Encode qw(encode decode);
use Digest::SHA qw(sha256_hex);
use Cwd qw(abs_path getcwd);
use File::Basename qw(dirname basename);
use File::Path qw(make_path);
use File::Spec;
use File::Temp ();
BEGIN { $0 = Cygwin::win_to_posix_path($0) if $^O eq 'cygwin' && $0 =~ /\\/ }
use FindBin qw($Bin);
for my $hook (qw(shell git session-start guard-agent-memory guard-user-files guard-approval-link guard-project-safety
                guard-push guard-kill guard-stdin-code guard-commit-split guard-comments guard-role-tools)) {
    require "$Bin/$hook.pl";
}
for my $reminder (qw(quality-reminder screenshots-reminder)) {
    require "$Bin/../templates/hooks/$reminder.pl";
}

binmode STDIN, ':raw';
binmode STDOUT, ':raw';
my $json = JSON::PP->new->utf8->ascii->canonical;
my $event = $json->decode(do { local $/; <STDIN> });
my $kind = $event->{hook_event_name} // '';
my $tool = $event->{tool_name} // '';
my $input = $event->{tool_input} // {};
my $session = $event->{session_id} // '';
my $cwd = path_at(getcwd(), $event->{cwd} // getcwd());
my $root = $cwd;
while (!-f "$root/.codex/team-charter.md" && dirname($root) ne $root) {
    $root = dirname($root);
}
my $project = -f "$root/.codex/team-charter.md";
$root = $cwd unless $project;
my $config = {};
my $data = $ENV{PLUGIN_DATA};
my $cache = defined $data && length $data && length $session
    ? path_at(getcwd(), $data) . '/hook-state' : undef;
my $flags_file = "$root/.codex/barriers.json";
if ($project && -f $flags_file) {
    $config = eval { $json->decode(raw_file($flags_file)) };
    unless (ref $config eq 'HASH') {
        warn "BeerPowers: invalid .codex/barriers.json. Using guard defaults.\n";
        $config = {};
    }
}

sub raw_file {
    open my $fh, '<:raw', $_[0] or die "read $_[0]: $!";
    local $/;
    return <$fh> // '';
}

sub path_at {
    my ($base, $path) = @_;
    $path =~ tr|\\|/|;
    if ($^O eq 'cygwin' && $path =~ m{^(?:[A-Za-z]:/|//)}) {
        $path = Cygwin::win_to_posix_path($path);
    }
    $path = "$base/$path" unless File::Spec->file_name_is_absolute($path) || $path =~ m{^[a-z]:/}i;
    my @tail;
    while (!-e $path && dirname($path) ne $path) {
        unshift @tail, basename($path);
        $path = dirname($path);
    }
    my $head = abs_path($path) // $path;
    for my $part (@tail) {
        next if $part eq '.';
        if ($part eq '..') { $head = dirname($head); next }
        $head .= "/$part";
    }
    return $head;
}

sub emit {
    print $json->encode($_[0]), "\n";
    exit 0;
}
sub context {
    my @notes = @_;
    if ($kind eq 'SessionStart' || $kind eq 'SubagentStart') {
        my $reader = abs_path("$Bin/../bin/role-files.mjs");
        $reader = Cygwin::posix_to_win_path($reader) if $^O eq 'cygwin';
        my $package = dirname(dirname($reader));
        if ($^O eq 'cygwin' || $^O eq 'MSWin32') {
            $package = Cygwin::posix_to_win_path(abs_path("$Bin/..")) if $^O eq 'cygwin';
            $package =~ s/'/''/g;
            push @notes, "BeerPowers: в начале каждого вызова PowerShell с командой из установленного пакета выполни строку:\n\$packageRoot = '$package'\nРабочий каталог — корень внешнего workspace.";
        } else {
            $package =~ s/'/'\\''/g;
            push @notes, "BeerPowers: в начале каждого вызова оболочки с командой из установленного пакета выполни строку:\npackageRoot='$package'\nРабочий каталог — корень внешнего workspace.";
        }
        push @notes, "BeerPowers: для перехода по Markdown-ссылке с подсказкой beerpowers:reference/ передай ссылку целиком одним аргументом в Read через node \"$reader\". Обработчик открывает выбранный справочник установленного пакета. Если уже видишь адрес beerpowers:reference/…, передай только его.";
    }
    my $text = join "\n\n", grep { defined && length } @notes;
    exit 0 unless length $text;
    emit({hookSpecificOutput => {hookEventName => $kind, additionalContext => $text}});
}
sub deny {
    my ($guard, $text) = @_;
    emit({hookSpecificOutput => {hookEventName => 'PreToolUse', permissionDecision => 'deny',
          permissionDecisionReason => "$guard: $text"}});
}
sub enabled {
    my ($key, $default) = @_;
    return $config->{$key} if JSON::PP::is_bool($config->{$key});
    return $default // 1;
}

# IDs and command arguments never become filesystem path components.
sub state_file {
    return undef unless defined $cache;
    return "$cache/" . sha256_hex(encode('UTF-8', join "\0", $session, @_));
}
sub remember {
    my ($file, $value) = @_;
    return unless defined $file;
    make_path($cache, { mode => 0700 });
    my ($fh, $tmp) = File::Temp::tempfile(DIR => $cache, UNLINK => 0);
    print {$fh} $value;
    close $fh or die "write state: $!";
    rename $tmp, $file or die "save state: $!";
}
sub seen {
    my ($file, $value) = @_;
    return defined $file && -f $file && raw_file($file) eq $value;
}
my ($window, $setup_root) = setup_window();

# Code mode: normalize a single call with a JSON literal. Never evaluate JavaScript.
sub exact_tool_input {
    my ($name, $argument) = @_;
    $name = 'apply_patch' if $name eq 'functions.apply_patch';
    if ($name =~ /\A(?:functions\.)?exec\z/) {
        my $code = ref($argument) eq 'HASH' ? ($argument->{code} // $argument->{command}) : $argument;
        if (defined($code) && !ref($code)) {
            $code =~ s/\A\s*text\((await [\s\S]*)\);?\s*\z/$1/;
            if ($code =~ /\A\s*await tools\.(exec_command|write_stdin|apply_patch|web__run)\(([\s\S]+)\);?\s*\z/) {
                my ($inner, $literal) = ($1, $2);
                my $arg = eval { $json->decode(encode('UTF-8', $literal)) };
                if (!$@ && (($inner eq 'apply_patch' && !ref($arg) && defined($arg)) ||
                            ($inner ne 'apply_patch' && ref($arg) eq 'HASH'))) {
                    ($name, $argument) = ($inner, $arg);
                }
            }
        }
    }
    $argument = {command => $argument} if $name eq 'apply_patch' && !ref($argument);
    return ($name, $argument);
}

sub patch_paths {
    my ($text, $base) = @_;
    return unless $text =~ /^\*{3} Begin Patch\r?$/m && $text =~ /^\*{3} End Patch\r?$/m;
    my @paths;
    while ($text =~ /^\*{3} (Add File|Update File|Delete File|Move to): ([^\r\n]+)\r?$/mg) {
        my ($action, $path) = (substr($1, 0, index($1, ' ')), path_at($base // $cwd, $2));
        # A rename also removes its source.
        $paths[-1][0] = 'Move' if $action eq 'Move' && @paths;
        push @paths, [$action, $path];
    }
    return @paths;
}
session_start($event, "$Bin/..", $project, $root, $json) if $kind eq 'SessionStart';
if ($kind eq 'UserPromptSubmit') {
    setup_prompt($root, $window, $event);
    exit 0;
}
if ($kind eq 'Stop') {
    setup_stop($window, $setup_root, $event);
    emit({});
}
if ($kind =~ /^Subagent(Start|Stop)$/) {
    context() if $kind eq 'SubagentStart' && (!$project || !enabled('screenshots-reminder', 0));
    emit({}) unless $project;
    my $stop = $kind eq 'SubagentStop';
    my $message = 'Тимлид: проверь изменённые файлы, отчёт роли и SHA, затем прими гейт.';
    emit($stop ? {systemMessage => $message} : {}) unless enabled('screenshots-reminder', 0);
    screenshots_reminder($event, $json, $root, $cwd, $stop, $message);
    emit({systemMessage => $message});
}
exit 0 unless $project || defined $setup_root;
exit 0 unless $kind eq 'PreToolUse' || $kind eq 'PostToolUse';
($tool, $input) = exact_tool_input($tool, $input);
guard_role_tools($event, $root, $cwd, $json, $tool, $input) if $project && $kind eq 'PreToolUse';
exit 0 unless $tool =~ /^(?:Bash|apply_patch|(?:functions\.)?request_user_input(?:_async)?|(?:functions\.)?exec(?:_command)?)$/;
guard_approval_link($project, $input) if $tool =~ /^(?:functions\.)?request_user_input(?:_async)?$/;
my $cmd = ref $input eq 'HASH' ? ($input->{command} // $input->{cmd}) : undef;
if ($tool =~ /^(?:functions\.)?exec$/ || !defined $cmd || ref $cmd) {
    context('BeerPowers advisory: событие не содержит точной команды или патча. Проверь действие и ограничения вручную.');
}
if ($tool eq 'apply_patch') {
    my @paths = patch_paths($cmd);
    context('BeerPowers advisory: не удалось разобрать список файлов apply_patch.') unless @paths;
    quality($root, $project, @paths) if $kind eq 'PostToolUse';
    changed_path($project, $setup_root, @$_) for @paths;
} elsif ($tool =~ /^(?:Bash|(?:functions\.)?exec_command)$/) {
    my $opt = {
        project => $project, setup_root => $setup_root, root => $root, config => $config,
        project_safety => $kind eq 'PreToolUse' && $project && -f "$root/.codex/rules/beerpowers-safety.rules",
        post => $kind eq 'PostToolUse'
    };
    inspect_shell($cmd, $cwd, 0, $opt);
    context('BeerPowers advisory: действие или часть команды не удалось определить точно. Проверь цель в этой оболочке.') if $opt->{advisory};
}
