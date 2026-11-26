use strict;
use warnings;
use utf8;

sub quality {
    my ($root, $project, @paths) = @_;
    my $gates = "$root/.codex/quality-gates.txt";
    exit 0 unless $project && -f $gates;
    my @rules = split /\r?\n/, decode('UTF-8', raw_file($gates));
    my %already;
    my @notes;
    for my $entry (@paths) {
        my $relative = File::Spec->abs2rel($entry->[1], $root);
        $relative =~ tr|\\|/|;
        for my $line (@rules) {
            next unless $line =~ /^\s*([^#\s]\S*)\s+(.+)$/;
            my ($glob, $message) = ($1, $2);
            next unless grep {
                my $re = quotemeta($_);
                $re =~ s/\\\*/.*/g;
                $re =~ s/\\\?/./g;
                length($_) && ($entry->[1] =~ /^$re$/ || $relative =~ /^$re$/ || "/$relative" =~ /^$re$/)
            } split /\|/, $glob;
            push @notes, $message unless $already{$message}++;
            last;
        }
    }
    context(@notes);
}

1;
