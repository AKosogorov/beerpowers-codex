use strict;
use warnings;
use Test::More;
use Cwd qw(getcwd);
use File::Temp qw(tempdir);
use File::Path qw(make_path);
use File::Basename qw(dirname);
use Digest::SHA qw(sha256_hex);
use JSON::PP;
BEGIN { $0 = Cygwin::win_to_posix_path($0) if $^O eq 'cygwin' && $0 =~ /\\/ }
use FindBin qw($Bin);

my $package = "$Bin/../plugins/beerpowers";
my $original = getcwd();
my $ws = tempdir(CLEANUP => 1);
chdir $ws or die $!;
END { chdir $original if defined $original }
sub put {
    my ($path, $body) = @_;
    make_path(dirname($path));
    open my $f, '>:raw', $path or die "$path: $!";
    print {$f} $body;
    close $f or die $!;
}
sub bytes {
    open my $f, '<:raw', shift or die $!;
    local $/; return scalar <$f>;
}
sub run {
    local $ENV{BEERPOWERS_TEST_COMMAND} = 'git diff --check';
    local $ENV{BEERPOWERS_TEST_SOURCE} = 'README.md';
    open my $p, '-|', $^X, "$package/bin/workspace.pl", @_ or die $!;
    local $/; my $out = <$p> // '';
    close $p;
    return ($? >> 8, $out);
}
sub git_ok { system('git', @_) == 0 or die "git @_ failed" }
git_ok('init', '-qb', 'main');
my $product = 'projects/demo';
make_path($product);
git_ok('-C', $product, 'init', '-qb', 'main');
put("$product/README.md", "git diff --check\n");
put("$product/php/composer.json", '{"require":{"laravel/framework":"*","elasticsearch/elasticsearch":"*"}}');
put("$product/ui/package.json", '{"dependencies":{"nuxt":"*","@supabase/supabase-js":"*"}}');
put("$product/php/app/Policy.php", "<?php\n");
put("$product/php/database/migrations/create.php", "<?php\n");
put("$product/ui/app/Button.vue", "<template/>\n");
put("$product/.gitlab-ci.yml", "stages: [test]\n");
git_ok('-C', $product, 'add', '.');

my $legacy_agent = "<!-- beerpowers:engine entry -->\r\n(.codex/team-charter.md) (.codex/team-lead.md)\r\n<!-- /beerpowers:engine -->\r\nmanual";
my %legacy = (
    '.codex/workspace.json' => '{"beerpowers":"0.5.0","schemaVersion":1}',
    '.codex/team-charter.md' => "charter with manual additions\n",
    '.codex/roles/reviewer.md' => "custom reviewer scope\n",
    'memory/MEMORY.md' => "legacy index\n",
    '.codex/agent-memory/reviewer/MEMORY.md' => "manual feedback index\n",
    '.codex/agent-memory/reviewer/feedback_scope.md' => "manual feedback detail\n",
);
put($_, $legacy{$_}) for keys %legacy;
put('AGENTS.md', $legacy_agent);
my ($plan_code, $preview) = run('plan');
is($plan_code, 0, 'legacy 0.5 plan accepts manual files');
like($preview, qr{Detected stacks \(projects/demo\): elasticsearch, gitlab, laravel, nuxt, postgres, supabase},
    'plan detects all six stacks from tracked manifests');
ok(!-e '.codex/role-settings.json', 'plan read only');
is((run('apply'))[0], 0, 'upgrade fills missing 0.6 files');
is(bytes($_), $legacy{$_}, "preserves $_") for sort keys %legacy;
is(bytes('AGENTS.md'), $legacy_agent, 'short entry preserves manual bytes');
my $cfg = decode_json(bytes('.codex/role-settings.json'));
like(bytes('.codex/quality-gates.txt'),qr{\*/projects/[^/]+/\*\|\*/worktrees/\*/[^/]+/\* Проверка проекта: git diff --check}, 'one generated gate covers both checkout layouts');
ok(!exists $cfg->{stacks}, 'stack discovery has no duplicate JSON field');
is_deeply($cfg->{rules}, {}, 'framework detection does not invent domain rules');
is_deeply([glob('.codex/rules/*.md')], [], 'setup ships no generic path rules');
my %picked = (
    policy => {paths => ['php/app'], text => "# Policy\n\nOnly the active tenant may change a catalog entry."},
    invoice => {paths => ['php/database/migrations'], text => "# Invoice\n\nArchived invoices retain the owner reference."},
    visibility => {paths => ['ui/app/Button.vue'], text => "# Visibility\n\nHide the action for catalog viewers."},
);
{
    local $ENV{BEERPOWERS_PATH_RULES_JSON} = encode_json({demo => {bad => {paths => ['php/missing'], text => 'Do not generate'}}});
    ok((run('plan'))[0], 'setup rejects a rule path with no tracked evidence');
    ok(!-e '.codex/rules/bad.md', 'invalid proposal writes nothing');
}
{
    local $ENV{BEERPOWERS_PATH_RULES_JSON} = encode_json({demo => \%picked});
    is((run('plan'))[0], 0, 'confirmed path rules are plannable');
    is_deeply([glob('.codex/rules/*.md')], [], 'path rule plan is read only');
    is((run('apply'))[0], 0, 'setup saves project rules and their actual paths');
    like((run('apply'))[1], qr/^No changes\.$/m, 'same path rule input is idempotent');
}
$cfg = decode_json(bytes('.codex/role-settings.json'));
is_deeply($cfg->{rules}, {map { $_ => $picked{$_}{paths} } keys %picked}, 'only approved paths are bound');
put('memory/project/domain-invariants.md', "Domain fact from project owner.\n");
my @roles = qw(architect auditor backend database devops explorer frontend product reviewer tester);
for my $role (@roles, 'team-lead') {
    my ($rc, $out) = run('role-packet', $role, 'php/database/migrations/create.php');
    is($rc, 0, "role packet $role");
    if ($role ne 'team-lead') {
        my $name = $role eq 'tester' ? 'testing' : $role;
        my $path = ".codex/agents/$name-agent.md";
        my $text = bytes($path);
        like($out, qr/\QFILE $path sha256=\E@{[sha256_hex($text)]}\n\Q$text\E/, "delivers the full $role agent");
        unlike($text, qr/\{\{[A-Z_]+\}\}/, 'no unresolved role slots');
    }
    like($out, qr/^FILE \.codex\/rules\/invoice\.md /m, 'matched migration rule');
    unlike($out, qr/^FILE \.codex\/rules\/(?:policy|visibility)\.md /m, 'unrelated path rules excluded');
    unlike($out, qr/^FILE .*reply_/m, 'global reply rules outside role packet');
    if ($role eq 'explorer') {
        unlike($out, qr/^FILE memory\/project\/domain-invariants.md/m, 'explorer receives only relevant discovery context');
    } else {
        like($out, qr/^FILE memory\/project\/domain-invariants.md sha256=.*\nDomain fact from project owner\./m,
            "$role receives current invariants after setup migration");
    }
    unlike($out, qr{^FILE \.codex/roles/(?:guides|presets)/}m, 'no separate guide or preset files');
    like($out, qr/^FILE .+\/skills\/minimal-diff\/SKILL\.md sha256=/m, 'role receives installed skill');
    my %required = (
        architect => [qw(brainstorm grill prototype)],
        product => [qw(brainstorm grill prototype tracker-task)],
        'team-lead' => [qw(brainstorm grill prototype tracker-task summarizing-mr-links)],
        reviewer => [qw(summarizing-mr-links)],
        backend => [qw(debug-loop)],
    );
    for my $skill (@{$required{$role} // []}) {
        my $skill_text = bytes("$package/skills/$skill/SKILL.md");
        ok($out =~ /^FILE .+\/skills\/\Q$skill\E\/SKILL\.md sha256=@{[sha256_hex($skill_text)]}\n\Q$skill_text\E/m,
            "$role receives the full instructions of $skill");
    }
    like($out, qr/^FILE .+\/skills\/page-screenshot\/SKILL\.md sha256=/m, 'tester receives browser skill') if $role eq 'tester';
    unlike($out, qr/^FILE .+\/skills\/page-screenshot\/SKILL\.md sha256=/m, 'reviewer receives only applicable skills') if $role eq 'reviewer';
}
my ($rc, $body) = run('role-packet', 'reviewer', 'ui/app/Button.vue', 'php/app/Policy.php');
is($rc, 0, 'multi-path review');
for my $path (qw(.codex/agents/reviewer-agent.md .codex/agent-memory/reviewer/feedback_scope.md .codex/rules/visibility.md .codex/rules/policy.md)) {
    my $text = bytes($path);
    like($body, qr/\QFILE $path sha256=\E@{[sha256_hex($text)]}\n\Q$text\E/, "delivers current content of $path");
}
my $unrelated = (run('role-packet', 'tester', 'php/application/example'))[1];
unlike($unrelated, qr/^FILE \.codex\/rules\//m, 'prefix boundary prevents app vs application collision');
unlike($unrelated, qr/feedback_scope\.md/, 'other role memory excluded');
ok((run('role-packet', 'reviewer', '../outside'))[0], 'rejects ambiguous path traversal');
ok((run('role-packet', '../outside'))[0], 'rejects unknown role');
$cfg->{stacks} = ['nuxt'];
$cfg->{rules}{local} = ['ui'];
put('.codex/rules/local.md', "manual project obligation\n");
put('.codex/role-settings.json', encode_json($cfg));
($rc, $body) = run('role-packet', 'reviewer');
like($body, qr/manual project obligation/, 'unknown file scope includes configured custom rules');
unlike($body, qr/^FILE \.codex\/roles\/presets\/laravel/m, 'disabled stack excluded');
is((run('apply'))[0], 0, 'preserves custom settings on repeat');
is(decode_json(bytes('.codex/role-settings.json'))->{stacks}[0], 'nuxt', 'manual preference retained');
unlink '.codex/rules/local.md' or die $!;
ok((run('doctor'))[0], 'doctor rejects missing referenced custom rule');
put('.codex/rules/local.md', "manual project obligation\n");
my $second = 'projects/other';
make_path($second);
git_ok('-C', $second, 'init', '-qb', 'main');
put("$second/README.md", "git diff --check\n");
put("$second/php/app/Policy.php", "<?php\n");
git_ok('-C', $second, 'add', '.');
{
    local $ENV{BEERPOWERS_TESTS_JSON} = encode_json({
        map { $_ => {command => 'git diff --check', source => 'README.md', profile => 'main-default'} } qw(demo other)
    });
    local $ENV{BEERPOWERS_PATH_RULES_JSON} = encode_json({
        other => {catalog => {paths => ['php/app'], text => 'Only catalog owners edit catalog entries.'}}
    });
    is((run('apply'))[0], 0, 'second product binds confirmed rules without replacing original product rules');
}
git_ok('-C', $second, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture checkout');
my $second_tree = 'worktrees/SHOP-1/other';
git_ok('-C', $second, 'worktree', 'add', '-qb', 'SHOP-1', "../../$second_tree");
ok(-f "$second_tree/php/app/Policy.php", 'fixture has a product worktree');
{
    local $ENV{BEERPOWERS_REPO} = 'other';
    my $rel = substr("$second_tree/php/app/Policy.php", length($second_tree) + 1);
    my ($code, $packet) = run('role-packet', 'reviewer', $rel);
    is($code, 0, 'worktree role packet uses the product-relative path');
    like($packet, qr/Only catalog owners edit catalog entries/, 'selected product rule reaches its worktree');
    unlike($packet, qr/Only the active tenant/, 'same path in another product receives separate rules');
}
{
    local $ENV{BEERPOWERS_REPO} = 'demo';
    my ($code, $packet) = run('role-packet', 'reviewer', 'php/app/Policy.php');
    is($code, 0, 'original product still resolves after adding second');
    like($packet, qr/Only the active tenant/, 'original product rules retained');
    unlike($packet, qr/Only catalog owners edit catalog entries/, 'second product rule stays scoped');
}
done_testing();
