use strict;
use warnings;
use Cwd qw(getcwd);
use File::Find;
use File::Path qw(make_path);
use File::Temp qw(tempdir);
use Digest::SHA qw(sha256_hex);
use Encode qw(encode);
use JSON::PP;
use Test::More;
BEGIN { $0 = Cygwin::win_to_posix_path($0) if $^O eq 'cygwin' && $0 =~ /\\/ }
use FindBin qw($Bin);

my $handler = "$Bin/../plugins/beerpowers/bin/workspace.pl";
my $original = getcwd();
my $tmp = tempdir(CLEANUP => 1);
my $product = 'projects/demo';
my $code = 'fix/header-scroll';
my $file = "memory/tasks/$code/preflight.md";
my $json = JSON::PP->new->utf8;
my %brief = (class => 'lean', reason => 'One UI zone, existing example', statement => "Keep \"scroll\".\nPreserve position.",
    scope => 'Header only', acceptance => 'Position remains constant', forks => 'None', stops => 'Second layer');
my $note = {date => '2026-11-24', quote => "Also retain focus.\nExactly here. " . chr(0x42F), effect => 'Include keyboard focus'};

sub put {
    open my $fh, '>:raw', $_[0] or die "$_[0]: $!";
    print {$fh} $_[1];
    close $fh or die $!;
}
sub read_all {
    open my $fh, '<:raw', $_[0] or die "$_[0]: $!";
    local $/;
    return scalar(<$fh>) // '';
}
sub run_cmd {
    open my $fh, '-|', @_ or die $!;
    local $/;
    my $out = <$fh> // '';
    close $fh;
    return ($? >> 8, $out);
}
sub git {
    my ($status, $out) = run_cmd('git', @_);
    die "git @_ failed" if $status;
    chomp $out;
    return $out;
}
sub start {
    local $ENV{BEERPOWERS_TASK_JSON} = $json->encode(\%brief);
    return run_cmd($^X, $handler, 'task-start', @_);
}
sub snapshot {
    my %result;
    find({no_chdir => 1, wanted => sub {
        $result{$_} = -d $_ ? 'dir' : sha256_hex(read_all($_));
    }}, '.');
    return \%result;
}

make_path("$tmp/work space/$product");
chdir "$tmp/work space" or die $!;
END { chdir $original if defined $original }
$ENV{GIT_AUTHOR_NAME} = $ENV{GIT_COMMITTER_NAME} = 'Test';
$ENV{GIT_AUTHOR_EMAIL} = $ENV{GIT_COMMITTER_EMAIL} = 'test@example.org';
$ENV{GIT_CONFIG_GLOBAL} = '/dev/null';
$ENV{GIT_CONFIG_NOSYSTEM} = 1;
git('init', '-qb', 'outer');
git('-C', $product, 'init', '-qb', 'stable');
put("$product/README.md", "Project\n");
git('-C', $product, 'add', '.');
git('-C', $product, 'commit', '-qm', 'local default');
git('clone', '-q', '--bare', $product, "$tmp/remote.git");
git('-C', $product, 'remote', 'add', 'origin', "$tmp/remote.git");
git('clone', '-q', "$tmp/remote.git", "$tmp/author");
put("$tmp/author/new", "remote only\n");
git('-C', "$tmp/author", 'add', 'new');
git('-C', "$tmp/author", 'commit', '-qm', 'remote default advanced');
git('-C', "$tmp/author", 'push', '-q', 'origin', 'stable');
my $remote_tip = git('-C', "$tmp/author", 'rev-parse', 'HEAD');
git('-C', $product, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/obsolete');
local $ENV{BEERPOWERS_TEST_COMMAND} = 'git diff --check';
local $ENV{BEERPOWERS_TEST_SOURCE} = 'README.md';
is((run_cmd($^X, $handler, 'apply'))[0], 0, 'setup');
put('.codex/workspace.json', '{"beerpowers":"0.2.0"}');
git('add', '.');
git('commit', '-qm', 'configured by 0.2.0');
my $initial = git('rev-parse', 'HEAD');

my $snapshot = snapshot();
my ($status, $out) = start($code, '--preview');
is($status, 0, 'preview supported on legacy workspace');
like($out, qr/Compatible workspace: created by 0\.2\.0/, 'package mismatch reported');
like($out, qr/Class: lean.*Stop conditions: Second layer/s, 'preview reaches intake');
is_deeply(snapshot(), $snapshot, 'preview preserves every file including both Git directories');
for my $bad ('../outside', 'fix//bad', 'fix/NUL.txt', 'fix/COM1', 'fix/a.', 'fix/a.lock', 'fix/../x',
        'a:b', 'HEAD', 'stable', '-b', 'fix\\bad', '.git', 'fix/.git/setup') {
    isnt((start($bad))[0], 0, "reject $bad");
}
for my $flags (['--unknown'], ['--repo'], ['--repo', 'missing']) {
    isnt((start($code, @$flags))[0], 0, "reject @$flags");
}
is_deeply(snapshot(), $snapshot, 'unsupported calls leave no writes');
make_path('memory/tasks/CaseSensitive', "$tmp/outside");
isnt((start('casesensitive/new'))[0], 0, 'case alias in parent rejected');
SKIP: {
    my $link = 'memory/tasks/link';
    # Git for Windows can emulate symlink() by copying the directory. Create
    # an actual NTFS junction to exercise the host's path traversal behavior.
    if ($^O eq 'cygwin') {
        local $ENV{BP_TEST_LINK} = Cygwin::posix_to_win_path(getcwd() . "/$link");
        local $ENV{BP_TEST_TARGET} = Cygwin::posix_to_win_path("$tmp/outside");
        system('powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
            'New-Item -ItemType Junction -ErrorAction Stop -Path $env:BP_TEST_LINK -Target $env:BP_TEST_TARGET | Out-Null') == 0
            or die "Cannot create test junction";
    } else {
        skip 'filesystem cannot create symlink', 2 unless symlink("$tmp/outside", $link);
    }
    isnt((start('link/new'))[0], 0, 'linked task path stopped');
    ok(!-e "$tmp/outside/new", 'nothing created through link');
    if ($^O eq 'cygwin') {
        local $ENV{BP_TEST_LINK} = Cygwin::posix_to_win_path(getcwd() . "/$link");
        system('powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
            '[IO.Directory]::Delete($env:BP_TEST_LINK)') == 0 or die "Cannot remove test junction";
    } else {
        unlink $link or die $!;
    }
}
rmdir 'memory/tasks/CaseSensitive' or die $!;
rmdir 'memory/tasks' or die $!;
{
    local $ENV{BEERPOWERS_TASK_JSON} = $json->encode(\%brief);
    ($status, $out) = run_cmd($^X, $handler, 'task-plan', $code);
    is($status, 0, 'internal plan reads origin before ordinary start');
    like($out, qr/Base: origin\/stable \Q$remote_tip\E/, 'plan resolves remote HEAD instead of stale tracking ref');
    is_deeply(snapshot(), $snapshot, 'internal plan is read-only');
}
put('unrelated.txt', 'staged by user');
git('add', 'unrelated.txt');
isnt((start($code))[0], 0, 'outer staged work stops preparation');
is(git('show', ':unrelated.txt'), 'staged by user', 'unrelated index entry retained');
git('restore', '--staged', '--', 'unrelated.txt');
unlink 'unrelated.txt' or die $!;
put('.codex/git-settings.json', '{"repos":{"demo":"custom"}}');
isnt((start($code))[0], 0, 'unsupported custom profile');
git('restore', '.codex/git-settings.json');
put("$product/other", 'mine');
{
    local $ENV{BEERPOWERS_TASK_JSON} = $json->encode(\%brief);
    ($status, $out) = run_cmd($^X, $handler, 'task-plan', $code);
    is($status, 0, 'dirty product can plan independent checkout');
    like($out, qr{worktrees/\Q$code\E/demo}, 'plan names separate worktree');
}
ok(!-e 'memory/tasks', 'no premature artifacts');
is(read_all("$product/other"), 'mine', 'untracked product work retained');
unlink "$product/other" or die $!;
git('-C', $product, 'checkout', '-qb', 'other');
git('-C', $product, 'remote', 'set-url', 'origin', "$tmp/unavailable");
$snapshot = snapshot();
is((start($code, '--preview'))[0], 0, 'preview succeeds on occupied branch with unreachable origin');
is_deeply(snapshot(), $snapshot, 'offline preview has no side effects');
git('-C', $product, 'remote', 'set-url', 'origin', "$tmp/remote.git");
{
    local $ENV{BEERPOWERS_TASK_JSON} = $json->encode(\%brief);
    ($status, $out) = run_cmd($^X, $handler, 'task-plan', $code);
    is($status, 0, 'occupied branch selects independent checkout');
    like($out, qr{worktrees/\Q$code\E/demo}, 'occupied branch worktree path');
}
git('-C', $product, 'checkout', '-q', 'stable');

# Fail the external commit after staging. A retry may finish exactly this
# artifact, while a manual edit after the interruption must stop the retry.
my $hooks = "$tmp/hooks";
make_path($hooks);
put("$hooks/pre-commit", "#!/bin/sh\nexit 1\n");
chmod 0755, "$hooks/pre-commit" or die $!;
git('config', 'core.hooksPath', $hooks);
$brief{clarifications} = [$note];
isnt((start($code))[0], 0, 'simulated interruption after staging');
ok(-f $file && -f '.git/beerpowers-task-start.json', 'recoverable pending artifact');
is(git('rev-parse', 'HEAD'), $initial, 'no premature artifact commit');
is(git('-C', $product, 'branch', '--show-current'), 'stable', 'product branch untouched during commit failure');
my $pending_body = read_all($file);
put($file, "$pending_body\nManual change\n");
isnt((start($code))[0], 0, 'manual edit after interruption stops retry');
is(read_all($file), "$pending_body\nManual change\n", 'interrupted manual work preserved');
put($file, $pending_body);
unlink "$hooks/pre-commit" or die $!;
is((start($code))[0], 0, 'retry completes');
is(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), $file, 'only preflight in outer commit');
is(git('-C', $product, 'rev-parse', 'HEAD'), $remote_tip, 'branch starts at advertised remote commit');
is(git('-C', $product, 'branch', '--show-current'), $code, 'literal branch name including slash');
ok(!-e '.git/beerpowers-task-start.json' && !-e "memory/tasks/$code/git-flow.md" && !-e "memory/tasks/$code/tracker",
    'ordinary base has only preflight');
like($pending_body, qr/> Keep "scroll"\.\n> Preserve position\./, 'source quoted verbatim');
like($pending_body, qr/2026-11-24.*> Also retain focus\.\n> Exactly here\..*Include keyboard focus/s, 'dated quote and impact');
ok(index($pending_body, encode('UTF-8', chr(0x42F))) >= 0, 'UTF-8 input preserved through environment');
put($file, "$pending_body\nManual section\n");
git('add', '--', $file);
git('commit', '-qm', 'manual edit');
put("$product/work", 'done before resume');
git('-C', $product, 'add', '.');
git('-C', $product, 'commit', '-qm', 'manual product progress');
my $outer = git('rev-parse', 'HEAD');
my $inner = git('-C', $product, 'rev-parse', 'HEAD');
$snapshot = snapshot();
is((start($code, '--preview'))[0], 0, 'resume preview');
is_deeply(snapshot(), $snapshot, 'resume preview preserves both histories, indexes and working files');
is((start($code))[0], 0, 'unchanged resume');
is(git('rev-parse', 'HEAD'), $outer, 'no duplicate artifact commit');
is(git('-C', $product, 'rev-parse', 'HEAD'), $inner, 'product progress retained');
is(read_all($file), "$pending_body\nManual section\n", 'manual section and previous quote retained');
$brief{clarifications} = [{%$note, quote => 'New decision', effect => 'Extend scope'}];
is((start($code))[0], 0, 'new clarification');
like(read_all($file), qr/Manual section.*> New decision\n/s, 'append after manual bytes');
git('-C', $product, 'checkout', '-q', 'stable');
$brief{class} = 'trivial';
$brief{clarifications} = [];
$outer = git('rev-parse', 'HEAD');
is((start('typo/readme'))[0], 0, 'trivial preparation');
ok(!-e 'memory/tasks/typo', 'trivial has no folder');
is(git('rev-parse', 'HEAD'), $outer, 'trivial has no artifact commit');
is((start('typo/readme'))[0], 0, 'trivial repeat preserves branch');
git('-C', $product, 'checkout', '-q', 'stable');
$brief{class} = 'lean';
my $recovery = 'resume/existing';
make_path("memory/tasks/$recovery");
put("memory/tasks/$recovery/preflight.md", "Manually completed brief\n");
git('add', "memory/tasks/$recovery/preflight.md");
git('commit', '-qm', 'task artifact exists before branch');
$outer = git('rev-parse', 'HEAD');
is((start($recovery))[0], 0, 'recover missing product branch after external artifact commit');
is(git('rev-parse', 'HEAD'), $outer, 'no replay of existing artifact commit');
is(git('-C', $product, 'rev-parse', "refs/heads/$recovery"), $remote_tip, 'restored missing branch at verified base');
is(read_all("memory/tasks/$recovery/preflight.md"), "Manually completed brief\n", 'manual preflight preserved');

# Hand the reviewer an immutable, complete product patch even when the lead's
# current directory is the external workspace. No Git calls by the reviewer.
put("$product/format", "implementation\n");
git('-C', $product, 'add', '--', 'format');
git('-C', $product, 'commit', '-qm', 'implementation');
my $implementation = git('-C', $product, 'rev-parse', 'HEAD');
put("$product/format.t", "regression test\n");
git('-C', $product, 'add', '--', 'format.t');
git('-C', $product, 'commit', '-qm', 'regression coverage');
my $source = git('-C', $product, 'rev-parse', 'HEAD');
sub review_patch {
    return run_cmd($^X, $handler, 'review-diff', @_);
}
($status, $out) = review_patch($recovery, $remote_tip, $source);
is($status, 0, 'review handoff from legacy workspace');
like($out, qr/^Source: \Q$source\E$/m, 'handoff identifies tested source');
my ($patch) = $out =~ /^Patch: (.+)$/m;
ok(defined($patch) && -f $patch, 'full patch is available to role by path');
if (defined $patch && -f $patch) {
    is(read_all($patch), (run_cmd('git', '-C', $product, 'diff', '--binary', '--full-index',
        '--no-ext-diff', '--no-textconv', $remote_tip, $source, '--'))[1], 'patch includes implementation and later test commit');
    unlink $patch or die $!;
}
isnt((review_patch($recovery, $remote_tip, $implementation))[0], 0, 'stale source rejected');
isnt((review_patch('wrong-branch', $remote_tip, $source))[0], 0, 'wrong checkout rejected');
isnt((review_patch($recovery, 'HEAD', $source))[0], 0, 'floating base rejected');
put("$product/unlisted.t", "uncommitted test\n");
isnt((review_patch($recovery, $remote_tip, $source))[0], 0, 'uncommitted test cannot be omitted from review');

# Resume the real checkout with a partial test, mixed index, and an unfinished
# outer report. Merely entering this branch cannot establish hunk ownership.
my $task_dir = "memory/tasks/$recovery";
my $handover = "$task_dir/handover.md";
my $tests = "$task_dir/test-cases.md";
my $review = "$task_dir/review-report.md";
put("$product/format", "first partial implementation\n");
git('-C', $product, 'add', '--', 'format');
put("$product/format", "first partial implementation\nmanual edit\n");
put($tests, "Unfinished tester report\n");
git('-C', $product, 'remote', 'set-url', 'origin', "$tmp/unavailable");
delete $ENV{BEERPOWERS_TASK_JSON};
$snapshot = snapshot();
($status, $out) = run_cmd($^X, $handler, 'task-start', $recovery);
is($status, 0, 'new chat resumes existing dirty task without origin or original brief');
like($out, qr/Resume existing lean task.*MM format.*\?\? unlisted\.t/s, 'exposes staged, unstaged and untracked changes for reconciliation');
is((start($recovery))[0], 0, 'normal entry with saved brief also routes to reconciliation');
is_deeply(snapshot(), $snapshot, 're-entry preserves every file and both Git indexes');

my %pause = (head => $source, digest => 'missing', date => '2026-11-24', phase => 'impl',
    owner => 'team-lead', done => "base $remote_tip", in_flight => 'classify both hunks in format',
    blockers => 'ownership of manual edit', next => 'reconcile with owner');
sub handover_cmd {
    my ($action, $data) = @_;
    local $ENV{BEERPOWERS_HANDOVER_JSON} = $json->encode($data);
    return run_cmd($^X, $handler, 'handover', $recovery, $action);
}
is((handover_cmd('pause', \%pause))[0], 0, 'pause records unfinished work on dirty task branch');
my $paused = read_all($handover);
like($paused, qr/## Пауза.*impl.*\Q$source\E.*classify both hunks.*ownership of manual edit.*reconcile with owner/s,
    'handover contains current phase, revision, owner work, blocker and next step');
isnt((handover_cmd('pause', \%pause))[0], 0, 'stale handover digest rejected');
my $prefix = "# Notes\r\n\r\n```md\r\n## Пауза\r\n```\r\n\r\n";
my $suffix = "## User notes\r\n\r\nKeep this paragraph.\r\n";
put($handover, $prefix . ($paused =~ s/\n/\r\n/gr) . "\r\n" . $suffix);
$pause{digest} = sha256_hex(read_all($handover));
$pause{next} = 'resume tested scope';
is((handover_cmd('pause', \%pause))[0], 0, 'replace just the live pause among user notes');
my $updated = read_all($handover);
is($updated, $prefix . ($paused =~ s/reconcile with owner/resume tested scope/r =~ s/\n/\r\n/gr) . "\r\n" . $suffix,
    'manual sections, fenced example and original CRLF preserved byte for byte');
$pause{digest} = sha256_hex($updated);
($status, $out) = handover_cmd('pause', \%pause);
is("$status $out" =~ /0 .*No changes\./s, 1, 'duplicate pause is a no-op');
my %finish = (digest => $pause{digest}, head => $source, base => $remote_tip, tested => $source,
    reviewed => $source, verdict => 'APPROVED', exit => 0);
isnt((handover_cmd('clear', \%finish))[0], 0, 'dirty source cannot clear pause');
git('-C', $product, 'restore', '--staged', '--worktree', '--', 'format');
unlink "$product/unlisted.t" or die $!;
put($tests, "Full suite at $source, exit 0\n");
put($review, "NOT APPROVED at $implementation\nAPPROVED at $source\n");
for my $invalid ({tested => $implementation}, {reviewed => $implementation}, {verdict => 'NOT APPROVED'}, {exit => 1}) {
    isnt((handover_cmd('clear', {%finish, %$invalid}))[0], 0, 'stale or failed gate does not clear pause');
}
is(read_all($handover), $updated, 'failed gates preserve pause');
put($review, "APPROVED $source\n**NOT APPROVED** для source SHA `$source`\n");
isnt((handover_cmd('clear', \%finish))[0], 0, 'earlier approval cannot override latest rejection on same revision');
put($review, "APPROVED $source\n**APPROVED** для source SHA `$implementation`\n");
isnt((handover_cmd('clear', \%finish))[0], 0, 'older matching SHA in report cannot mask latest review of a different source');
put($review, "NOT APPROVED $implementation\nAPPROVED $source\n");
put($tests, "Full run: $source exit=0\nFull run: $source exit=1\n");
isnt((handover_cmd('clear', \%finish))[0], 0, 'latest failed full run supersedes previous green on same revision');
put($tests, "Full run: $source exit=0\n");
is((handover_cmd('clear', \%finish))[0], 0, 'complete before updating handover: clear current pause');
is(read_all($handover), $prefix . $suffix, 'only live pause was removed');
git('add', '--', $tests, $review, $handover);
git('commit', '-qm', 'record verified completion');
$finish{digest} = sha256_hex(read_all($handover));
$snapshot = snapshot();
($status, $out) = run_cmd($^X, $handler, 'task-start', $recovery);
is($status, 0, 'completed pilot re-enters on legacy setup');
like($out, qr/^Source: \Q$source\E$/m, 'returns actual reviewed revision');
($status, $out) = handover_cmd('clear', \%finish);
is($status, 0, 'last successful run and APPROVED at current revision accepted');
like($out, qr/No changes\./, 'completed task has no pending handover update');
is_deeply(snapshot(), $snapshot, 'completed re-entry creates no branches, commits or writes');
done_testing();
