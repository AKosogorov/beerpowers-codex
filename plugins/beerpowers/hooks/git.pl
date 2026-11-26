use strict;
use warnings;
use utf8;

# Only fixed, read-only Git commands are spawned. Never execute the incoming command.
sub git_read {
    my ($repo, @args) = @_;
    return '' unless -d $repo;
    # A diff against the worktree can invoke a configured clean/process filter.
    # A hook must not launch workspace programs as a side effect of inspecting a commit.
    my @overrides;
    if ($args[0] eq 'diff' && !grep { $_ eq '--cached' } @args) {
        my $keys = git_read($repo, 'config', '--null', '--name-only', '--get-regexp',
            '^filter\..*\.(clean|process)$');
        my %drivers = map { /^(filter\..*)\.(?:clean|process)$/ ? ($1 => 1) : () } split /\0/, $keys;
        for my $driver (sort keys %drivers) {
            push @overrides, '-c', "$driver.clean=", '-c', "$driver.process=", '-c', "$driver.required=false";
        }
    }
    $repo = Cygwin::posix_to_win_path($repo) if $^O eq 'cygwin';
    local $ENV{GIT_TERMINAL_PROMPT} = 0;
    local $ENV{GIT_NO_LAZY_FETCH} = 1;
    open my $fh, '-|', 'git', '--no-optional-locks', '-c', 'core.fsmonitor=false',
        '-c', 'core.quotePath=false', @overrides, '-C', $repo, @args or return '';
    local $/;
    my $output = <$fh> // '';
    unless (close $fh) {
        opaque() if $args[0] eq 'diff';
        return '';
    }
    return decode('UTF-8', $output);
}
sub commit_ranges {
    my ($repo, @args) = @_;
    my ($all, $include, @paths);
    while (@args) {
        my $a = shift @args;
        if ($a eq '--') { push @paths, @args; last }
        if ($a !~ /^-/) { push @paths, $a; next }
        if ($a eq '--all') { $all = 1; next }
        if ($a eq '--include') { $include = 1; next }
        next if $a =~ /^--(?:only|no-edit|amend|allow-empty|allow-empty-message|signoff|no-verify|quiet|verbose|edit|status|no-status|gpg-sign(?:=.*)?|no-gpg-sign)$/;
        if ($a =~ /^--(?:message|file|author|date|template|reuse-message|reedit-message|fixup|squash|cleanup)(=.*)?$/) {
            shift @args unless defined $1;
            next;
        }
        if ($a =~ /^-([^-].*)$/) {
            my $flags = $1;
            while (length $flags) {
                my $f = substr($flags,0,1,'');
                if ($f eq 'a') { $all = 1; next }
                if ($f eq 'i') { $include = 1; next }
                next if $f =~ /^[oqvsen]$/;
                if ($f =~ /^[mFCct]$/) { shift @args unless length $flags; last }
                opaque();
            }
            next;
        }
        opaque(); # Interactive/pathspec-file modes do not expose their selection in argv.
    }
    opaque() if grep { dynamic_word($_) || /^:/ } @paths;
    return (['--cached','--']) unless $all || @paths;
    my $head = git_read($repo, 'rev-parse', '--verify', '--quiet', 'HEAD');
    $head ||= git_read($repo, 'hash-object', '-t', 'tree', '--stdin');
    chomp $head;
    opaque() unless length $head;
    return ([$head,'--']) if $all;
    my @ranges = ([$head, '--', @paths]);
    push @ranges, ['--cached', '--', map { ":(exclude,literal)$_" } @paths] if $include;
    return @ranges;
}
sub guard_commit {
    my ($repo, $cfg, @args) = @_;
    return unless enabled('guard-comments') || enabled('guard-commit-split');
    my @ranges = commit_ranges($repo, @args);
    my @diff = ('diff', '--no-color', '--no-ext-diff', '--no-textconv');
    guard_commit_split($repo, \@diff, \@ranges) if enabled('guard-commit-split');
    guard_comments($repo, $cfg, \@diff, \@ranges) if enabled('guard-comments');
}

1;
