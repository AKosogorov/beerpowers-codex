use strict;
use warnings;
use Cwd qw(getcwd);
use utf8;
use Encode qw(decode_utf8 encode_utf8);
use File::Copy qw(copy);
use File::Basename qw(dirname);
use File::Find qw(find);
use File::Path qw(make_path);
use File::Spec;
use File::Temp qw(tempdir);
use JSON::PP qw(encode_json);
use Test::More;
BEGIN { $0 = Cygwin::win_to_posix_path($0) if $^O eq 'cygwin' && $0 =~ /\\/ }
use FindBin qw($Bin);

my $fixture = "$Bin/fixtures/catalog";
my $handler = "$Bin/../plugins/beerpowers/bin/workspace.pl";
my $original = getcwd();
my $temp = tempdir(CLEANUP => 1);
my $workspace = "$temp/catalog workspace";
my $product = 'projects/frontend';
my $task = 'fix/catalog-caption';
my $preflight = "memory/tasks/$task/preflight.md";
die "Usage: perl tests/codex-example.t\n" if @ARGV;
END { chdir $original if defined $original }

sub run_ok {
    open my $pipe, '-|', @_ or die "Cannot run $_[0]: $!";
    my $output = do { local $/; <$pipe> } // '';
    close $pipe or BAIL_OUT("@_ failed (exit " . ($? >> 8) . ")\n$output");
    $output =~ s/\r\n/\n/g;
    return $output;
}

sub read_text {
    my ($path) = @_;
    open my $file, '<:raw', $path or die "$path: $!";
    my $text = do { local $/; <$file> } // '';
    $text =~ s/\r\n/\n/g;
    return $text;
}

make_path($workspace);
chdir $workspace or die $!;

local $ENV{GIT_AUTHOR_NAME} = local $ENV{GIT_COMMITTER_NAME} = 'Catalog fixture';
local $ENV{GIT_AUTHOR_EMAIL} = local $ENV{GIT_COMMITTER_EMAIL} = 'catalog@example.invalid';
local $ENV{GIT_CONFIG_NOSYSTEM} = 1;
local $ENV{GIT_CONFIG_GLOBAL} = File::Spec->devnull;
local $ENV{XDG_CONFIG_HOME} = $^O eq 'cygwin' ? Cygwin::posix_to_win_path($temp) : $temp;
local $ENV{GIT_ALLOW_PROTOCOL} = 'file';
run_ok('git', 'init', '-qb', 'main');
for my $name (qw(backend frontend)) {
    my $source = "$fixture/$name";
    my $checkout = "projects/$name";
    make_path($checkout);
    find({no_chdir => 1, wanted => sub {
        return unless -f $_;
        my $target = "$checkout/" . File::Spec->abs2rel($File::Find::name, $source);
        make_path(dirname($target));
        copy($_, $target) or die "Copy $_ to $target: $!";
    }}, $source);
    run_ok('git', '-C', $checkout, 'init', '-qb', 'main');
    run_ok('git', '-C', $checkout, 'add', '.');
    run_ok('git', '-C', $checkout, 'commit', '-qm', 'Catalog fixture');
    run_ok('git', 'clone', '-q', '--bare', $checkout, "$temp/$name.git");
    run_ok('git', '-C', $checkout, 'remote', 'add', 'origin', "$temp/$name.git");
}

local $ENV{BEERPOWERS_TESTS_JSON} = encode_json({
    backend => {command => 'git diff --check', source => 'README.md'},
    frontend => {command => 'perl t/catalog.t', source => 'README.md'},
});
local $ENV{BEERPOWERS_TRACK} = 'dev';
local $ENV{BEERPOWERS_TEAM_SIZE} = 'extended';
local $ENV{BEERPOWERS_ROLE_SLOTS_JSON} = encode_json({frontend => {ROLE_SCOPE => 'Nuxt locale fixture in app/locales/', ROLE_CONTEXT => 'Select the frontend checkout.'}});
local $ENV{BEERPOWERS_MEMORY_JSON} = encode_json({
    projectMap => 'Frontend: app/locales/',
    domainInvariants => 'Every locale uses the same catalog keys.',
    breakpoints => 'Narrow viewport uses the catalog grid.',
    neverCode => 'Keep locale keys aligned.',
    confirmExtra => 'Confirm new supported locales.',
});
my $plan = run_ok($^X, $handler, 'plan');
like($plan, qr/Detected stacks \(projects\/frontend\): nuxt/, 'setup detects the stack');
ok(!-e '.codex', 'plan leaves workspace unconfigured');
run_ok($^X, $handler, 'apply');
like(read_text('memory/project/project-map.md'), qr{Frontend: app/locales/}, 'confirmed map fills the project slot');
like(read_text('memory/project/domain-invariants.md'), qr{Every locale uses the same catalog keys}, 'confirmed invariant fills the project slot');
like(read_text('memory/tests/frontend.md'), qr{Narrow viewport uses the catalog grid}, 'confirmed breakpoint fills the frontend slot');
like(decode_utf8(read_text('memory/project/safety-rules.md')), qr{Никогда.*Keep locale keys aligned.*Только после подтверждения пользователя.*Confirm new supported locales}s,
    'project safety notes occupy their own slots');
like(read_text("$product/README.md"), qr/^perl t\/catalog\.t$/m, 'recorded command has product evidence');
chdir $product or die $!;
my $product_tests = run_ok($^X, 't/catalog.t');
like($product_tests, qr/^ok \d+ - ru has text for catalogTitle$/m, 'documented product gate ran');
chdir $workspace or die $!;
like(run_ok($^X, $handler, 'apply'), qr/^No changes\.$/m, 'second setup is empty');
like(run_ok($^X, $handler, 'doctor'), qr/^Project OK: memory\/commands\/frontend\.md$/m, 'project doctor passes');
local $ENV{BEERPOWERS_REPO} = 'frontend';
my $packet = run_ok($^X, $handler, 'role-packet', 'frontend', 'app/locales/ru.json');
like($packet, qr{^FILE \.codex/agents/frontend-agent\.md }m, 'frontend packet contains the flat role');
like($packet, qr{Nuxt locale fixture in app/locales/}, 'confirmed stack slot is rendered into the role');
like($packet, qr{Select the frontend checkout\.}, 'confirmed project context overrides the default');
ok(!-e '.codex/roles', 'setup does not copy presets or guides');
unlike($packet, qr/^FILE \.codex\/rules\//m, 'no unsupported path rules are generated');

run_ok('git', 'add', '.');
run_ok('git', 'commit', '-qm', 'Configure catalog workspace');
my $base = run_ok('git', '-C', $product, 'rev-parse', 'HEAD');
chomp $base;
my $setup_commit = run_ok('git', 'rev-parse', 'HEAD');
my $statement = 'Исправь заголовок каталога только в русской локали.';
my $brief = {
    statement => $statement, class => 'lean', reason => 'One locale, existing keys',
    scope => 'app/locales/ru.json', acceptance => 'Only the Russian title changes',
    forks => 'None', stops => 'A shared key or another locale must change', clarifications => [],
};
local $ENV{BEERPOWERS_TASK_JSON} = encode_json($brief);
like(run_ok($^X, $handler, 'task-start', $task, '--preview'), qr/^Preview only\.$/m, 'preview classifies task');
is(run_ok('git', 'rev-parse', 'HEAD'), $setup_commit, 'preview creates no outer commit');
is(run_ok('git', '-C', $product, 'branch', '--show-current'), "main\n", 'preview preserves checkout');
ok(!-e $preflight, 'preview writes no task file');
like(run_ok($^X, $handler, 'task-plan', $task, '--repo', 'frontend'), qr/\Q$base\E/,
    'start plan resolves local origin HEAD');
run_ok($^X, $handler, 'task-start', $task, '--repo', 'frontend');
is(run_ok('git', '-C', $product, 'branch', '--show-current'), "$task\n", 'task branch is open');
is(run_ok('git', '-C', $product, 'rev-parse', 'HEAD'), "$base\n", 'task branch starts at the verified revision');
like(run_ok('git', 'show', "HEAD:$preflight"), qr/^> \Q@{[encode_utf8($statement)]}\E$/m, 'committed preflight quotes the original request');
my $task_commit = run_ok('git', 'rev-parse', 'HEAD');
delete $ENV{BEERPOWERS_TASK_JSON};
like(run_ok($^X, $handler, 'task-start', $task), qr/Resume existing lean task/, 'task can be resumed from its artifacts');
is(run_ok('git', 'rev-parse', 'HEAD'), $task_commit, 're-entry adds no commit');
done_testing;
