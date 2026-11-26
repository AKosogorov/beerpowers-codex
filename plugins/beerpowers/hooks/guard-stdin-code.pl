use strict;
use warnings;
use utf8;

sub guard_stdin_code {
    my ($name, $piped, $redirect, @args) = @_;
    return unless $name =~ /^(?:python[\d.]*|py|node|ruby|php|perl)$/;
    my $stdin = $piped || grep { $_->[0] =~ /^</ } @$redirect;
    for my $arg (@args) {
        if ($arg eq '-') { $stdin = 1; last }
        if ($arg !~ /^-/ || $arg =~ /^-(?:c|e|E|p|r|m|f|-(?:eval|print|test|run))$/) { $stdin = 0; last }
    }
    deny('guard-stdin-code', 'Запусти интерпретатор со скриптом по пути. Код из stdin запрещён.') if $stdin;
}

1;
