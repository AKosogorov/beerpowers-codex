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
chdir $tmp or die $!;
END { chdir $original if defined $original }
my $code = 'feature/two-products';
my $dir = "memory/tasks/$code";
my $json = JSON::PP->new->canonical->utf8;
$ENV{GIT_AUTHOR_NAME} = $ENV{GIT_COMMITTER_NAME} = 'Evidence fixture';
$ENV{GIT_AUTHOR_EMAIL} = $ENV{GIT_COMMITTER_EMAIL} = 'test@example.invalid';
$ENV{GIT_CONFIG_GLOBAL} = '/dev/null';
$ENV{GIT_CONFIG_NOSYSTEM} = 1;
$ENV{GIT_ALLOW_PROTOCOL} = 'file';

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
sub put {
    open my $file, '>:raw', $_[0] or die "$_[0]: $!";
    print {$file} $_[1];
    close $file or die $!;
}
sub bytes {
    open my $file, '<:raw', $_[0] or die "$_[0]: $!";
    local $/;
    return scalar <$file>;
}
sub digest { -f $_[0] ? sha256_hex(bytes($_[0])) : 'missing' }

git('init', '-qb', 'main');
my (%bases, @records);
for my $name (qw(api web)) {
    my $product = "projects/$name";
    make_path($product);
    git('-C', $product, 'init', '-qb', 'main');
    put("$product/README.md", "# $name\n\nCheck: git diff --check\n");
    git('-C', $product, 'add', '.');
    git('-C', $product, 'commit', '-qm', "seed $name");
    $bases{$name} = git('-C', $product, 'rev-parse', 'HEAD');
    my $checkout = $product;
    if ($name eq 'api') {
        $checkout = "worktrees/$code/$name";
        git('-C', $product, 'worktree', 'add', '-qb', $code, "$tmp/$checkout");
    } else {
        git('-C', $product, 'switch', '-qc', $code);
    }
    push @records, {name => $name, checkout => $checkout, baseSha => $bases{$name}, base => 'main', target => 'main'};
}
$ENV{BEERPOWERS_TESTS_JSON} = $json->encode({map { $_ => {command => 'git diff --check', source => 'README.md'} } qw(api web)});
is((run($^X, $handler, 'apply'))[0], 0, 'configure two products');
make_path($dir);
my $brief = "# $code\n\nКласс: feature. Cross-product date handling.\n\n" .
    join('', map { "Base-SHA $_: $bases{$_}\n" } qw(api web));
put("$dir/preflight.md", $brief);
put("$dir/checkouts.json", $json->encode({code => $code, repos => \@records}));
git('add', '.');
git('commit', '-qm', 'prepared multi-product task');

sub route {
    my ($repo, @args) = @_;
    local $ENV{BEERPOWERS_REPO} = $repo;
    return run($^X, $handler, @args);
}
sub feature {
    my ($repo, $event, $head, %args) = @_;
    local $ENV{BEERPOWERS_FEATURE_JSON} = $json->encode({head => $head, digest => digest("$dir/repos/$repo/feature-state.json"), %args});
    return (route($repo, 'feature-state', $code, $event))[0];
}
sub handover {
    my ($repo, $action, $head, %args) = @_;
    local $ENV{BEERPOWERS_HANDOVER_JSON} = $json->encode({head => $head, digest => digest("$dir/repos/$repo/handover.md"), %args});
    return (route($repo, 'handover', $code, $action))[0];
}
isnt((route('', 'feature-state', $code))[0], 0, 'ambiguous product selection stops');
for my $name (qw(api web)) {
    my ($status, $out) = route($name, 'feature-state', $code);
    is($status, 0, "status $name");
    like($out, qr/Evidence directory: \Q$dir\E\/repos\/$name\nBase: $bases{$name}\n/, 'pins repo and original base');
    ok(!-e "$dir/repos/$name", 'status remains read-only');
    is(feature($name, 'init', $bases{$name}, ui => 'no', requires_opponent => 'no', mode => 'C'), 0, "initialize $name");
    my $state = $json->decode(bytes("$dir/repos/$name/feature-state.json"));
    is($state->{brief}, sha256_hex($brief), 'uses shared preflight');
    is($state->{base}, $bases{$name}, 'uses per-product SHA');
    is(handover($name, 'pause', $bases{$name}, date => '2026-11-24', phase => 'design', done => 'started', owner => $name,
        in_flight => 'Design pending', blockers => 'none', next => 'finish design'), 0, "record separate pause for $name");
}
ok(!-e "$dir/handover.md" && !-e "$dir/feature-state.json", 'no shared execution state');
my $web = "$dir/repos/web";
my $api = "$dir/repos/api";
my $other_state = bytes("$web/feature-state.json");
my $other_pause = bytes("$web/handover.md");
put("$web/design-brief.md", "Design ready $bases{api}\n");
isnt(feature('api', 'design-ready', $bases{api}), 0, 'review cannot use sibling evidence');
put("$api/design-brief.md", "Design ready $bases{api}\n");
is(feature('api', 'design-ready', $bases{api}), 0, 'record design in own directory');
my $checkout = $records[0]{checkout};
put("$checkout/amount.txt", "10.05\n");
git('-C', $checkout, 'add', 'amount.txt');
git('-C', $checkout, 'commit', '-qm', 'implement');
my $head = git('-C', $checkout, 'rev-parse', 'HEAD');
is(feature('api', 'implemented', $head), 0, 'linked checkout revision recorded');
put("$api/early-review.md", "EARLY PASS $head\n");
is(feature('api', 'early-pass', $head), 0, 'early review passes');
put("$api/test-cases.md", "Full run: $head exit=0\n");
is(feature('api', 'tests-pass', $head), 0, 'successful tested revision');
put("$api/test-cases.md", bytes("$api/test-cases.md") . "Mutation PASS $head\n");
is(feature('api', 'mutations-pass', $head), 0, 'mutation gate');
put("$api/review-report.md", "APPROVED $head\n");
is(feature('api', 'final-approve', $head), 0, 'approved linked product');
my %finish = (base => $bases{api}, tested => $head, reviewed => $head, verdict => 'APPROVED', exit => 0);
put("$dir/preflight.md", $brief . "new acceptance\n");
isnt(handover('api', 'clear', $head, %finish), 0, 'changed shared preflight invalidates finish');
put("$dir/preflight.md", $brief);
is(handover('api', 'clear', $head, %finish), 0, 'clear only completed checkout');
is(bytes("$web/handover.md"), $other_pause, 'other pause remains intact');
is(bytes("$web/feature-state.json"), $other_state, 'other cursor remains intact');
isnt(handover('web', 'clear', $head, %finish), 0, 'cannot transfer completion');
done_testing();
