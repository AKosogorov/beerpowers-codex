use strict;
use warnings;
use utf8;

sub guard_kill {
    my ($name, @args) = @_;
    my $bad = $name =~ /^(?:pkill|killall)$/;
    if ($name eq 'taskkill') {
        $bad = !(grep { m{^/+PID$}i } @args) || grep { m{^/+(?:IM|FI)(?:$|:)}i } @args;
    } elsif ($name eq 'stop-process' || $name eq 'spps') {
        $bad = !(grep { /^-id$/i } @args) || grep { /^-(?:name|processname)$/i } @args;
    } elsif ($name eq 'kill') {
        $bad = grep { $_ eq '0' || $_ eq '-1' || /^-name$/i } @args;
    }
    deny('guard-kill', 'Останавливай только свой процесс по PID.') if $bad;
}

1;
