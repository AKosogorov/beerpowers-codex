use strict;
use warnings;
use Cwd qw(getcwd);
use Digest::SHA qw(sha256_hex);
use File::Path qw(make_path);
use File::Temp qw(tempdir);
use JSON::PP;
use Test::More;
BEGIN { $0 = Cygwin::win_to_posix_path($0) if $^O eq 'cygwin' && $0 =~ /\\/ }
use FindBin qw($Bin);

my $handler = "$Bin/../plugins/beerpowers/bin/workspace.pl";
my $original = getcwd();
my $tmp = tempdir(CLEANUP => 1);
my $repo = 'projects/demo';
my $task = 'feature/total';
my $dir = "memory/tasks/$task";
my $cursor = "$dir/feature-state.json";
my $json = JSON::PP->new->canonical->utf8;

sub put {
    open my $fh, '>:raw', $_[0] or die $!;
    print {$fh} $_[1] or die $!;
    close $fh or die $!;
}
sub bytes {
    open my $fh, '<:raw', $_[0] or die $!;
    local $/;
    return scalar <$fh>;
}
sub run {
    open my $pipe, '-|', @_ or die $!;
    local $/;
    my $out = <$pipe> // '';
    close $pipe;
    return ($? >> 8, $out);
}
sub git {
    my ($status, $out) = run('git', @_);
    die "git @_ failed" if $status;
    chomp $out;
    return $out;
}
sub state {
    my ($event, %data) = @_;
    my %payload = (head => git('-C', $repo, 'rev-parse', 'HEAD'),
        digest => -f $cursor ? sha256_hex(bytes($cursor)) : 'missing', %data);
    local $ENV{BEERPOWERS_FEATURE_JSON} = $json->encode(\%payload);
    return run($^X, $handler, 'feature-state', $task, defined $event ? $event : ());
}
sub event_ok {
    my ($event, $next, %data) = @_;
    my ($status, $out) = state($event, %data);
    is($status, 0, "$event accepted") or diag $out;
    like($out, qr/^Next: \Q$next\E$/m, "next gate $next");
}
sub append_line {
    my ($name, $line) = @_;
    my $path = "$dir/$name.md";
    my $body = -f $path ? bytes($path) : "# Fixture role report\n";
    put($path, "$body$line\n");
}
sub product_commit {
    my ($path, $body) = @_;
    put("$repo/$path", $body);
    git('-C', $repo, 'add', '--', $path);
    git('-C', $repo, 'commit', '-qm', "update $path");
    return git('-C', $repo, 'rev-parse', 'HEAD');
}
make_path("$tmp/outer/$repo");
chdir "$tmp/outer" or die $!;
END { chdir $original if defined $original }
$ENV{GIT_AUTHOR_NAME} = $ENV{GIT_COMMITTER_NAME} = 'Feature test';
$ENV{GIT_AUTHOR_EMAIL} = $ENV{GIT_COMMITTER_EMAIL} = 'test@example.org';
$ENV{GIT_CONFIG_GLOBAL} = '/dev/null';
$ENV{GIT_CONFIG_NOSYSTEM} = 1;
git('init', '-qb', 'outer');
git('-C', $repo, 'init', '-qb', 'stable');
my $base = product_commit('README.md', "full check: git diff --check\n");
git('clone', '-q', '--bare', $repo, "$tmp/origin.git");
git('-C', $repo, 'remote', 'add', 'origin', "$tmp/origin.git");
local $ENV{BEERPOWERS_TEST_COMMAND} = 'git diff --check';
local $ENV{BEERPOWERS_TEST_SOURCE} = 'README.md';
is((run($^X, $handler, 'apply'))[0], 0, 'setup');
put('.codex/workspace.json', '{"beerpowers":"0.2.0"}');
git('add', '.');
git('commit', '-qm', 'existing workspace');
my %brief = (statement => 'Display rounded total', class => 'feature', reason => 'UI and money', intake => 'design-only',
    scope => 'display', acceptance => 'correct total', forks => 'none', stops => 'none');
$ENV{BEERPOWERS_TASK_JSON} = $json->encode(\%brief);
is((run($^X, $handler, 'task-start', $task, '--preview'))[0], 0, 'feature preview');
ok(!-d $dir, 'preview no files');
is((run($^X, $handler, 'task-start', $task))[0], 0, 'feature preparation');
like(bytes("$dir/preflight.md"), qr/^Base-SHA: \Q$base\E$/m, 'pinned original base');
delete $ENV{BEERPOWERS_TASK_JSON};
my ($status, $out) = run($^X, $handler, 'task-start', $task);
like($out, qr/Resume existing feature task.*commands\/feature.md/s, 'local resume routes from files');
like($out, qr/^Intake: design-only$/m, 'local resume sees the task override');
is((state())[0], 0, 'read uninitialized state');
ok(!-e $cursor, 'read-only status');
event_ok('init', 'design', ui => 'yes', requires_opponent => 'yes', mode => 'C');
my $valid_state = bytes($cursor);
append_line('preflight', 'UI widths [demo]: declined 2026-11-25 — all widths');
unlike((state())[1], qr/Preflight changed/, 'dated width decision keeps the current feature gate');
my $bad_state = $json->decode($valid_state);
$bad_state->{head} = 'not-a-revision';
put($cursor, $json->encode($bad_state));
isnt((state())[0], 0, 'corrupt stored SHA rejected before Git uses it');
put($cursor, $valid_state);
isnt((state('design-ready'))[0], 0, 'cannot pass design without report');
append_line('design-brief', "Design ready $base");
my $stale_digest = sha256_hex(bytes($cursor));
event_ok('design-ready', 'implement');
isnt((state('implemented', digest => $stale_digest))[0], 0, 'cannot overwrite concurrent transition');
isnt((state('implemented'))[0], 0, 'cannot implement an empty diff');
my $first = product_commit('total', "10.123\n");
event_ok('implemented', 'early-review');
isnt((state('tests-pass'))[0], 0, 'tester cannot bypass early review');
append_line('early-review', "EARLY CHANGES $first");
event_ok('early-changes', 'fix');
is($json->decode(bytes($cursor))->{mode}, 'D', 'feedback escalates C to D');
my $head = product_commit('total', "10.12\n");
event_ok('fixed', 'early-review');
isnt((state('early-pass'))[0], 0, 'reject stale review');
append_line('early-review', "EARLY PASS $head");
event_ok('early-pass', 'tests', test_paths => ['check.t']);
my %pause = (head => $head, digest => 'missing', date => '2026-11-24', phase => 'test', owner => 'tester',
    done => 'early review accepted', in_flight => 'suite pending', blockers => 'none', next => 'run suite');
$ENV{BEERPOWERS_HANDOVER_JSON} = $json->encode(\%pause);
is((run($^X, $handler, 'handover', $task, 'pause'))[0], 0, 'feature pause');
my $saved = bytes($cursor);
($status, $out) = run($^X, $handler, 'task-start', $task);
like($out, qr/feature-state\.json/, 'paused feature resumes offline');
is(bytes($cursor), $saved, 'resume preserves state');
$head = product_commit('NOTES.md', "new product path after early review\n");
append_line('test-cases', "Full run: $head exit=0");
isnt((state('tests-pass'))[0], 0, 'changed path outside exact reviewed test list requires another early review');
event_ok('production-changed', 'early-review');
append_line('early-review', "EARLY PASS $head");
event_ok('early-pass', 'tests', test_paths => ['check.t']);
$head = product_commit('check.t', "use Test::More tests => 1; open my \$f, '<', 'total' or die \$!; is(scalar(<\$f>), \"10.12\\n\", 'displayed total');\n");
chdir $repo or die $!;
is((run($^X, 'check.t'))[0], 0, 'fixture product test passes');
chdir '../..' or die $!;
append_line('test-cases', "Full run: $head exit=1");
isnt((state('tests-pass'))[0], 0, 'reject last red test');
append_line('test-cases', "Full run: $head exit=0");
event_ok('tests-pass', 'browser');
isnt((state('mutations-pass'))[0], 0, 'UI path requires browser phase');
my $accepted_suite = bytes("$dir/test-cases.md");
put("$dir/test-cases.md", "Browser PASS $head\n");
isnt((state('browser-pass'))[0], 0, 'later phase cannot replace previous passing run');
put("$dir/test-cases.md", $accepted_suite);
append_line('test-cases', "Browser PASS $head");
event_ok('browser-pass', 'mutations');
append_line('preflight', 'UI widths [demo]: revoked 2026-11-25 — full matrix required');
append_line('test-cases', "Mutation PASS $head");
isnt((state('mutations-pass'))[0], 0, 'changed UI decision invalidates earlier browser evidence');
event_ok('ui-matrix-changed', 'browser');
append_line('test-cases', "Browser PASS $head");
event_ok('browser-pass', 'mutations');
append_line('test-cases', "Mutation PASS $head");
event_ok('mutations-pass', 'opponent');
append_line('review-report', "APPROVED $head");
isnt((state('final-approve'))[0], 0, 'required independent opponent cannot be skipped');
my %finish = (head => $head, digest => sha256_hex(bytes("$dir/handover.md")), base => $base,
    tested => $head, reviewed => $head, exit => 0, verdict => 'APPROVED');
$ENV{BEERPOWERS_HANDOVER_JSON} = $json->encode(\%finish);
isnt((run($^X, $handler, 'handover', $task, 'clear'))[0], 0, 'lean completion route cannot bypass money gate');
isnt((run($^X, $handler, 'handover', $task, 'check'))[0], 0, 'unfinished money gate also blocks shutdown retro');
append_line('opponent-report', "Opponent PASS $head");
event_ok('opponent-pass', 'final-review');
append_line('review-report', "NOT APPROVED $head");
isnt((state('final-approve'))[0], 0, 'last rejection defeats prior approval');
append_line('review-report', "APPROVED $head");
event_ok('final-approve', 'done');
my $before_retro = bytes("$dir/handover.md");
is((run($^X, $handler, 'handover', $task, 'check'))[0], 0, 'completed task may collect retro before clear');
is(bytes("$dir/handover.md"), $before_retro, 'retro readiness check preserves handover');
is((run($^X, $handler, 'handover', $task, 'clear'))[0], 0, 'clear paused feature on verified current revision');
append_line('opponent-report', "Opponent CHANGES $head");
isnt((run($^X, $handler, 'handover', $task, 'clear'))[0], 0, 'post-approval evidence edit requires reconciliation');
my $prior = bytes("$dir/preflight.md");
put("$dir/preflight.md", "$prior\nChanged acceptance\n");
isnt((state('team-up'))[0], 0, 'changed preflight invalidates previous cursor');
event_ok('replan', 'design', ui => 'no', requires_opponent => 'no');
ok(@{$json->decode(bytes($cursor))->{history}} > 10, 'replan retains history');
is(bytes("$dir/preflight.md"), "$prior\nChanged acceptance\n", 'user content preserved');
append_line('design-brief', "Design ready $head");
event_ok('design-ready', 'implement');
event_ok('implemented', 'early-review');
append_line('early-review', "EARLY PASS $head");
event_ok('early-pass', 'tests');
isnt((state('tests-pass'))[0], 0, 'fresh run required at unchanged source after revised criteria');
append_line('test-cases', "Full run: $head exit=0");
event_ok('tests-pass', 'mutations');
append_line('test-cases', "Mutation PASS $head");
event_ok('mutations-pass', 'final-review');
isnt((state('final-approve'))[0], 0, 'approval from previous criteria cannot be reused');
append_line('review-report', "APPROVED $head");
event_ok('final-approve', 'done');

$task = 'economy-spot';
$dir = "memory/tasks/$task";
$cursor = "$dir/feature-state.json";
git('-C', $repo, 'checkout', '-qb', $task, $base);
make_path($dir);
put("$dir/preflight.md", "Класс: feature. Scoped fixture\nBase-SHA: $base\nIntake: autonomous\n");
git('add', "$dir/preflight.md");
git('commit', '-qm', 'economy task');
event_ok('init', 'design', ui => 'no', requires_opponent => 'no', mode => 'C');
append_line('design-brief', "Design ready $base");
event_ok('design-ready', 'implement');
my $spot = product_commit('choice.t', "use Test::More tests => 1; is(lc('CHOICE'), 'choice', 'output');\n");
event_ok('implemented', 'early-review');
append_line('early-review', "Review by: team-lead $spot\nEARLY PASS $spot");
isnt((state('early-pass'))[0], 0, 'local economy review needs a scoped decision at the exact SHA');
append_line('preflight', "Economy local review: $spot — one changed file, no critical scope");
event_ok('early-pass', 'tests');
chdir $repo or die $!;
is((run($^X, 'choice.t'))[0], 0, 'economy route still executes a real product check');
chdir '../..' or die $!;
append_line('test-cases', "Full run: $spot exit=0");
event_ok('tests-pass', 'mutations');
append_line('test-cases', "Mutation PASS $spot");
event_ok('mutations-pass', 'final-review');
append_line('review-report', "Review by: team-lead $spot\nAPPROVED $spot");
event_ok('final-approve', 'done');
is($json->decode(bytes($cursor))->{history}[-1]{review_by}, 'team-lead', 'cursor records actual reviewer');
$ENV{BEERPOWERS_HANDOVER_JSON} = $json->encode({head => $spot, digest => 'missing',
    base => $base, tested => $spot, reviewed => $spot, exit => 0, verdict => 'APPROVED'});
is((run($^X, $handler, 'handover', $task, 'check'))[0], 0, 'economy completion accepts verified local review');
done_testing();
