use strict;
use warnings;
use Test::More;
use Cwd qw(getcwd);
use File::Path qw(make_path);
use File::Temp qw(tempdir);
use JSON::PP qw(encode_json decode_json);
BEGIN { $0 = Cygwin::win_to_posix_path($0) if $^O eq 'cygwin' && $0 =~ /\\/ }
use FindBin qw($Bin);

my $handler = "$Bin/../plugins/beerpowers/bin/workspace.pl";
my $original = getcwd();
my $tmp = tempdir(CLEANUP => 1);
local $ENV{GIT_CONFIG_NOSYSTEM} = 1;
local $ENV{GIT_CONFIG_GLOBAL} = "$tmp/no-global-config";
local $ENV{XDG_CONFIG_HOME} = $^O eq 'cygwin' ? Cygwin::posix_to_win_path($tmp) : $tmp;
local $ENV{GIT_ALLOW_PROTOCOL} = 'file';
my $ws = "$tmp/Команда тест";
my $product = 'projects/ledger';
my $command = 'git -c "alias.verify-ledger=diff --check" verify-ledger HEAD';
my @input = ($command, 'README.md');
make_path("$ws/$product");
chdir $ws or die $!;
END { chdir $original if defined $original }

sub put {
    my ($path, $text) = @_;
    open my $file, '>:raw', $path or die "$path: $!";
    print {$file} $text;
    close $file or die $!;
}
sub read_all {
    open my $file, '<:raw', $_[0] or die $!;
    local $/;
    return scalar <$file>;
}
sub invoke {
    my ($mode, $command, $source, @args) = @_;
    local $ENV{BEERPOWERS_TEST_COMMAND} = $command // '';
    local $ENV{BEERPOWERS_TEST_SOURCE} = $source // '';
    open my $pipe, '-|', $^X, $handler, $mode, @args or die $!;
    local $/;
    my $out = <$pipe> // '';
    close $pipe;
    return ($? >> 8, $out);
}
sub git_ok { system('git', @_) == 0 or die "git @_ failed" }
sub git_head {
    open my $pipe, '-|', 'git', '-C', $_[0], 'rev-parse', 'HEAD' or die "git: $!";
    my $head = <$pipe>;
    close $pipe or die "git rev-parse failed";
    chomp $head;
    return $head;
}

git_ok('init', '-qb', 'main');
git_ok('-C', $product, 'init', '-qb', 'main');
put("$product/README.md", "# Ledger\n\nChecks: $command\n");
git_ok('-C', $product, 'add', 'README.md');
git_ok('-C', $product, '-c', 'user.name=Test', '-c', 'user.email=test@example.org', 'commit', '-qm', 'product');
git_ok('-C', $product, '-c', 'alias.verify-ledger=diff --check', 'verify-ledger', 'HEAD');
my $manual = "\xef\xbb\xbf# Правила\r\nРучная строка";
put('AGENTS.md', $manual);
put('.gitignore', "# правила\r\n*.tmp\r\n");
make_path('.claude', 'memory');
put('.claude/workspace.json', '{"beerpowers":"2.15.0"}');
put('memory/MEMORY.md', "Старая память\n");

my ($code, $out) = invoke('plan', @input);
is($code, 0, 'plan passes');
unlike($out, qr/\.claude|2\.15\.0/, 'foreign configuration kept out of setup output');
like($out, qr/Existing memory/, 'existing memory reported');
like($out, qr/\Q$command\E/, 'plan shows actual command');
ok(!-e '.codex' && !-e 'memory/commands', 'plan creates no generated files');
is(read_all('AGENTS.md'), $manual, 'plan preserves manual bytes');
is((invoke('apply', @input))[0], 0, 'apply passes');
($code, $out) = invoke('doctor');
is($code, 0, 'doctor passes');
like($out, qr/Role binding: project \.codex\/agents\/<role>-agent\.md .*write limits are instructions/, 'doctor explains brief-based role binding');
like(read_all('AGENTS.md'), qr/^\Q$manual\E\r\n/, 'BOM, manual text and EOL preserved');
is(read_all('memory/MEMORY.md'), "Старая память\n", 'existing index preserved');
ok(!-e 'memory/project/project-map.md', 'setup respects the pre-existing shared memory layout');
is(read_all('.claude/workspace.json'), '{"beerpowers":"2.15.0"}', 'legacy config preserved');
like(read_all('memory/commands/ledger.md'), qr/\Q$command\E/, 'command saved in project memory');
git_ok('check-ignore', '-q', '--', "$product/README.md");
git_ok('check-ignore', '-q', '--', 'worktrees/T-1/ledger/example');
for my $private (qw(.codex/git-settings.local.json .codex/figma-settings.json .codex/yandex-tracker-settings.json
        .codex/.cache/task-start/T-1/task.md memory/tasks/fix/demo/screenshots/a.png
        memory/tasks/T-1/figma/p.png memory/tasks/T-1/tracker/task-attachment/image.png)) {
    git_ok('check-ignore', '-q', '--', $private);
}
is(system('git', 'check-ignore', '-q', '--', 'memory/tasks/T-1/tracker/task.md') >> 8, 1, 'tracker statement remains shared');
put('.codex/team-charter.md', read_all('.codex/team-charter.md') . "\nРучное дополнение\n");
git_ok('add', '.');
git_ok('-c', 'user.name=Test', '-c', 'user.email=test@example.org', 'commit', '-qm', 'baseline');
($code, $out) = invoke('apply', @input);
is($code, 0, 'repeat passes');
like($out, qr/^No changes\.$/m, 'repeat has empty plan');
git_ok('diff', '--exit-code');
git_ok('-C', $product, 'diff', '--exit-code', 'HEAD');

for my $invalid ('{"beerpowers":"0.3.0"}', '{"beerpowers":"0.2.0","unexpected":true}',
        '{"beerpowers":"0.9.0","schemaVersion":2}', '{"beerpowers":"0.2.0","schemaVersion":"1"}',
        '{"beerpowers":"damaged","schemaVersion":1}', '[]') {
    put('.codex/workspace.json', $invalid);
    ok((invoke('apply', @input))[0] != 0, "unsupported workspace retained: $invalid");
    is(read_all('.codex/workspace.json'), $invalid, 'invalid config preserved');
}
for my $valid ('{"beerpowers":"0.2.0"}', '{"beerpowers":"0.8.1","schemaVersion":1}') {
    put('.codex/workspace.json', $valid);
    ($code, $out) = invoke('apply', @input);
    is($code, 0, 'compatible workspace accepted');
    like($out, qr/Compatible workspace: created by .*No changes\./s, 'version difference diagnosed without migration');
    is(read_all('.codex/workspace.json'), $valid, 'compatible config remains byte-identical');
}
git_ok('restore', '.codex/workspace.json');
put('.codex/git-settings.json', '{bad');
ok((invoke('doctor'))[0] != 0, 'doctor detects invalid profile file');
ok((invoke('apply', @input))[0] != 0, 'setup refuses conflicting file');
is(read_all('.codex/git-settings.json'), '{bad', 'conflict retained');
git_ok('restore', '.codex/git-settings.json');
ok((invoke('apply', 'other command', 'README.md'))[0] != 0, 'conflicting command preserved for review');
unlink '.codex/agents/reviewer-agent.md' or die $!;
ok((invoke('doctor'))[0] != 0, 'doctor detects missing role');
is((invoke('apply', @input))[0], 0, 'setup restores missing role');
put('.gitignore', "/projects/\n");
ok((invoke('doctor'))[0] != 0, 'doctor detects missing ignore');
git_ok('restore', '.gitignore');
put('.codex/git-settings.local.json', '{"reviewers":{"ledger":["fixture-reviewer"]}}');
git_ok('add', '-f', '.codex/git-settings.local.json');
($code, $out) = invoke('doctor');
ok($code != 0, 'doctor detects tracked personal settings');
unlike($out, qr/fixture-reviewer/, 'personal setting values absent from diagnostics');
git_ok('restore', '--staged', '--', '.codex/git-settings.local.json');
unlink '.codex/git-settings.local.json' or die $!;
make_path('projects/other');
git_ok('-C', 'projects/other', 'init', '-qb', 'main');
ok((invoke('apply', @input))[0] != 0, 'multiple products need individual test inputs');
put('projects/other/README.md', "Other checks\n");
put('projects/other/package.json', '{"dependencies":{"nuxt":"1"}}');
git_ok('-C', 'projects/other', 'add', '.');
local $ENV{BEERPOWERS_TESTS_JSON} = encode_json({
    ledger => {command=>$command, source=>'README.md', profile=>'main-default'},
    other => {command=>'node --test', source=>'README.md', profile=>'custom'}
});
($code, $out) = invoke('plan');
is($code, 0, 'plan additional product');
like($out, qr/UPDATE \.codex\/git-settings.json/, 'profile extension visible before applying');
is((invoke('apply'))[0], 0, 'add configured product to existing workspace');
is_deeply(decode_json(read_all('.codex/git-settings.json'))->{repos}, {ledger=>'main-default', other=>'custom'}, 'per-product profiles');
is_deeply(decode_json(read_all('.codex/role-settings/other.json'))->{stacks}, ['nuxt'], 'rules discovered for second product');
like(read_all('memory/commands/other.md'), qr/node --test/, 'second test command');
is((invoke('doctor'))[0], 0, 'multi-product doctor');
ok((invoke('role-packet', undef, undef, 'frontend'))[0] != 0, 'multi-product role requires scope');
{
    local $ENV{BEERPOWERS_REPO} = 'other';
    ($code, $out) = invoke('role-packet', undef, undef, 'frontend', 'pages/home.vue');
    is($code, 0, 'scoped role packet');
    like($out, qr/FILE memory\/commands\/other.md/, 'selected command in scoped packet');
    like($out, qr/FILE \.codex\/agents\/frontend-agent.md/, 'frontend agent in scoped packet');
}
($code, $out) = invoke('apply');
is($code, 0, 'multi-product repeat passes');
like($out, qr/^No changes\.$/m, 'multi-product repeat is empty');
my $task = 'GL-3';
my $tree = "worktrees/$task/ledger";
make_path("worktrees/$task", "memory/tasks/$task");
my $base = git_head($product);
git_ok('-C', $product, 'worktree', 'add', '-q', '-b', $task, "../../$tree", $base);
put("$tree/change.txt", "review me\n");
git_ok('-C', $tree, 'add', 'change.txt');
git_ok('-C', $tree, '-c', 'user.name=Test', '-c', 'user.email=test@example.org', 'commit', '-qm', 'fixture change');
my $head = git_head($tree);
put("memory/tasks/$task/checkouts.json", encode_json({repos=>[{name=>'ledger', checkout=>$tree}]}));
{
    local $ENV{TMPDIR} = $tmp;
    ($code, $out) = invoke('review-diff', undef, undef, $task, $base, $head);
    is($code, 0, 'review resolver selects registered worktree from task');
    like($out, qr/^Checkout path: \Q$tree\E$/m, 'exact product worktree reported');
    put("memory/tasks/$task/checkouts.json", encode_json({repos=>[{name=>'ledger', checkout=>'projects/ledger'}]}));
    ok((invoke('review-diff', undef, undef, $task, $base, $head))[0] != 0, 'record cannot redirect review to wrong branch');
}
chdir $product or die $!;
ok((invoke('apply', @input))[0] != 0 && !-e '.codex', 'product root rejected without writes');
done_testing();
