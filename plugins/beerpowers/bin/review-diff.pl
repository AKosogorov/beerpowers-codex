# Готовит для ревью дифф от согласованной базы и проверяет его границы.
use strict;
use warnings;
use File::Temp qw(tempfile);

# Called by the lead from the outer workspace. Pin both ends so the reviewer
# can read the entire product patch from a file, including newly added tests.
sub review_diff {
    my ($product, $task, $base, $source) = @_;
    die "Expected task, base SHA and tested source SHA\n" unless @_ == 4
        && $base =~ /\A(?:[a-f0-9]{40}|[a-f0-9]{64})\z/ && $source =~ /\A(?:[a-f0-9]{40}|[a-f0-9]{64})\z/;
    my @repo = ('-C', $product);
    die "Wrong product checkout or stale source SHA\n"
        unless git_output(@repo, 'symbolic-ref', '--quiet', '--short', 'HEAD') eq "$task\n"
        && git_output(@repo, 'rev-parse', 'HEAD') eq "$source\n";
    die "Product has uncommitted changes; reconcile before review\n"
        if length git_output(@repo, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none');
    die "Expected a nonempty task range starting at an ancestor of source\n"
        if $base eq $source || system('git', @repo, 'merge-base', '--is-ancestor', $base, $source) != 0;

    my ($fh, $patch) = tempfile('beerpowers-review-XXXXXXXX', SUFFIX => '.patch', TMPDIR => 1);
    close $fh or die "$patch: $!\n";
    unless (system('git', @repo, 'diff', '--binary', '--full-index', '--no-color', '--no-ext-diff',
            '--no-textconv', '--ignore-submodules=none', "--output=$patch", $base, $source, '--') == 0 && -s $patch) {
        unlink $patch or die "$patch: $!\n";
        die "Could not export a nonempty product diff\n";
    }
    $patch = Cygwin::posix_to_win_path($patch) if $^O eq 'cygwin';
    print "Base: $base\nSource: $source\nPatch: $patch\n";
}

1;
