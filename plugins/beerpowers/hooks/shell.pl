use strict;
use warnings;
use utf8;

# Tokenize literal commands without invoking a shell or expanding shell variables.
# A quoted argument stays one word even if it contains a separator.
sub shell_tokens {
    my ($text) = @_;
    my @tokens;
    pos($text) = 0;
    while (pos($text) < length $text) {
        next if $text =~ /\G[\t \r]+/gc;
        if ($text =~ /\G(\n|&&|\|\||[;&|]|<<<|<<|>>|[<>])/gc) {
            push @tokens, ['operator', $1];
            next;
        }
        my $word = '';
        my $start = pos($text);
        while (1) {
            if ($text =~ /\G'([^']*)'/gc) { $word .= $1; next }
            if ($text =~ /\G"((?:\\\"|\x60"|[^"])*)"/gc) {
                my $part = $1;
                $part =~ s/[\\\x60]"/"/g;
                $word .= $part;
                next;
            }
            if ($text =~ /\G([^\t \r\n;&|<>'"]+)/gc) { $word .= $1; next }
            last;
        }
        return if pos($text) == $start;
        push @tokens, ['word', $word];
    }
    return @tokens;
}
sub opaque {
    die bless {}, 'BeerPowers::OpaqueSegment';
}
sub checked_segment {
    my ($words, $redir, $piped, $base, $depth, $opt) = @_;
    my $result = eval { inspect_segment($words,$redir,$piped,$base,$depth,$opt) };
    if (ref($@) eq 'BeerPowers::OpaqueSegment') {
        $opt->{advisory} = 1;
        return $base;
    }
    die $@ if $@;
    return $result;
}
sub dynamic_word { $_[0] =~ /[\$\x60*?\[\]{}]|%[^%]+%/ }
sub shell_basename {
    my $name = lc $_[0];
    $name =~ s{.*[\\/]}{};
    $name =~ s/\.exe$//;
    return $name;
}

sub inspect_shell {
    my ($cmd, $base, $depth, $opt) = @_;
    if ($depth > 6) { $opt->{advisory} = 1; return }
    # Unwrap literal shell -c arguments before stripping heredoc data inside them.
    if ($cmd =~ /^(?:[^\n]*[\\\/])?(?:bash|sh|cmd|pwsh|powershell)(?:\.exe)?\s/i) {
        my @outer = shell_tokens($cmd);
        if (@outer && !grep { $_->[0] ne 'word' } @outer) {
            checked_segment([map { $_->[1] } @outer], [], 0, $base, $depth, $opt);
            return;
        }
    }
    my @patch;
    $cmd =~ s{((?:^|[;&|]\s*)\s*apply_patch)\s+<<-?\s*['"]?(\w+)['"]?[ \t]*\r?\n(.*?)^\2[ \t]*\r?$}{
        my ($invocation, $body) = ($1, $3);
        push @patch, $body;
        "$invocation __beerpowers_patch_$#patch";
    }gmse;
    local $opt->{patches} = \@patch;
    $cmd =~ s/(<<-?\s*['"]?(\w+)['"]?[^\n]*\n).*?^\2[ \t]*\r?$/$1/msg;
    my @tokens = shell_tokens($cmd);
    if (!@tokens && $cmd =~ /\S/) { $opt->{advisory} = 1; return }
    my (@words, @redirections);
    my $piped = 0;
    for (my $i = 0; $i <= @tokens; $i++) {
        my ($type, $token) = $i == @tokens ? ('operator',';') : @{$tokens[$i]};
        if ($type eq 'word') { push @words, $token; next }
        if ($token =~ /^[<>]/) {
            my $next = $tokens[$i+1];
            push @redirections, [$token, $next && $next->[0] eq 'word' ? $tokens[++$i][1] : ''];
            next;
        }
        if (@words || @redirections) {
            $base = checked_segment(\@words, \@redirections, $piped, $base, $depth, $opt);
        }
        @words = ();
        @redirections = ();
        $piped = $token eq '|';
    }
}
sub inspect_segment {
    my ($words, $redirect, $piped, $base, $depth, $opt) = @_;
    my @args = @$words;
    for my $red (@$redirect) {
        next if $opt->{post};
        next unless $red->[0] =~ /^>/ && length $red->[1];
        next if $red->[1] =~ m{^(?:/dev/null|nul)$}i;
        opaque() if dynamic_word($red->[1]) && defined $opt->{setup_root};
        my $file = path_at($base, $red->[1]);
        my $action = $red->[0] eq '>' ? 'Write' : 'Update';
        changed_path($opt->{project}, $opt->{setup_root}, $action, $file);
    }
    shift @args while @args && ($args[0] =~ /^(?:env|command|exec|winpty|nohup|time)$/ || $args[0] =~ /^\w+=/);
    splice(@args, 0, 2) if @args >= 2 && $args[0] eq 'timeout' && $args[1] =~ /^\d/;
    return $base unless @args;
    my $name = shell_basename(shift @args);
    if ($name =~ /^(?:powershell|pwsh|bash|sh|cmd)$/) {
        while (@args) {
            my $flag = lc shift @args;
            if ($flag =~ /^(?:-command|-[a-z]*c|\/c)$/ && @args) {
                inspect_shell(join(' ', @args), $base, $depth+1, $opt);
                return $base;
            }
        }
        opaque() unless $opt->{post};
        return $base;
    }
    guard_project_shell($opt->{root}, $base, $name, @args) if $opt->{project_safety};
    if ($name =~ /^(?:cd|set-location|push-location|pushd)$/) {
        shift @args if @args && lc $args[0] =~ /^(?:-path|-literalpath|\/d)$/;
        opaque() unless @args == 1 && !dynamic_word($args[0]);
        return path_at($base, $args[0]);
    }
    if ($name eq 'apply_patch') {
        my $text = @args == 1 && $args[0] =~ /^__beerpowers_patch_(\d+)$/ && defined $opt->{patches}[$1]
            ? $opt->{patches}[$1] : join("\n", @args);
        my @paths = patch_paths($text, $base);
        opaque() unless @paths;
        quality($opt->{root}, $opt->{project}, @paths) if $opt->{post};
        changed_path($opt->{project}, $opt->{setup_root}, @$_) for @paths;
        return $base;
    }
    return $base if $opt->{post};
    if ($name eq 'git') {
        my $repo = $base;
        while (@args && $args[0] =~ /^-/) {
            my $flag = shift @args;
            if ($flag eq '-C' && @args) {
                opaque() if dynamic_word($args[0]);
                $repo = path_at($repo, shift @args);
            } elsif ($flag eq '-c') {
                shift @args;
            } elsif ($flag =~ /^--(?:git-dir|work-tree|namespace|exec-path)/) {
                opaque();
            }
        }
        my $sub = shift(@args) // '';
        guard_project_git($sub, @args) if $opt->{project_safety};
        guard_setup_git($sub, @args) if defined $opt->{setup_root};
        if ($opt->{project}) {
            guard_push($repo, $opt->{root}, @args) if $sub eq 'push' && enabled('guard-push');
            if ($sub eq 'commit') {
                opaque() if $opt->{index_changed};
                guard_commit($repo, $opt->{config}, @args);
            }
            $opt->{index_changed} = 1 if $sub =~ /^(?:add|rm|mv|reset|restore|checkout|switch|stash|apply|update-index|read-tree)$/;
        }
        return $base;
    }
    guard_kill($name, @args) if $opt->{project} && enabled('guard-kill');
    guard_stdin_code($name, $piped, $redirect, @args) if $opt->{project} && enabled('guard-stdin-code');
    guard_setup_shell($name) if defined $opt->{setup_root};
    if ($name =~ /^(?:set-content|sc|clear-content|add-content|ac|out-file|tee-object|tee|copy-item|cp|copy|move-item|mv|move|new-item|touch)$/) {
        my @targets;
        my $copy_move = $name =~ /^(?:copy-item|cp|copy|move-item|mv|move)$/;
        for (my $i=0; $i < @args-1; $i++) {
            my $is_target = $copy_move ? $args[$i] =~ /^-destination$/i : $args[$i] =~ /^-(?:path|literalpath|filepath)$/i;
            push @targets, $args[$i+1] if $is_target;
        }
        unless (@targets) {
            if ($copy_move) { push @targets, $args[-1] if @args && $args[-1] !~ /^-/ }
            elsif ($name eq 'touch') { @targets = grep { !/^-/ } @args }
            else { push @targets, $args[0] if @args && $args[0] !~ /^-/ }
        }
        opaque() unless @targets;
        for my $target (@targets) {
            opaque() if dynamic_word($target);
            my $file = path_at($base, $target);
            if (-d $file && $copy_move) {
                my $src = $args[0] // '';
                $src = $args[1] // '' if $src =~ /^-(?:literalpath|path)$/i;
                opaque() unless length($src) && $src !~ /^-/ && !dynamic_word($src);
                $file = path_at($file, basename(path_at($base, $src)));
            }
            my $append = $name =~ /^(?:ac|add-content|touch)$/ || grep { /^-append$/i } @args;
            changed_path($opt->{project}, $opt->{setup_root}, $append ? 'Update' : 'Write', $file);
        }
    }
    return $base;
}

1;
