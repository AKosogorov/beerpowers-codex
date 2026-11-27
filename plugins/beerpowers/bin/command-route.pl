# Разбирает явный вызов BeerPowers и проверяет имя команды по каталогу пакета.
use strict;
use warnings;
use Encode qw(decode FB_CROAK);
use JSON::PP;
BEGIN { $0 = Cygwin::win_to_posix_path($0) if $^O eq 'cygwin' && $0 =~ /\\/ }
use FindBin qw($Bin);

my $usage = "Usage: command-route.pl '<request>'\n";
if (@ARGV == 1 && $ARGV[0] eq '--help') { print $usage; exit 0 }
die $usage unless @ARGV == 1;
my $input = decode('UTF-8', $ARGV[0], FB_CROAK);
my $result = {status => 'ignored'};
if ($input =~ m{\A\s*(?:\$beerpowers|\[\$beerpowers\]\(skill://beerpowers\))
               (?=\s|\z)\s*(?:(\S+)(.*))?\z}sx) {
    my ($name, $tail) = ($1, $2);
    if (defined($name) && $name eq 'doctor' && $tail =~ /^\s+tech-debt-index\s*$/) {
        ($name, $tail) = ('tech-debt-index', '');
    }
    my $directory = "$Bin/../commands";
    opendir my $entries, $directory or die "$directory: $!\n";
    my @commands = sort map { s/\.md\z//r }
        grep { /\A[a-z][a-z0-9-]*\.md\z/ && -f "$directory/$_" } readdir $entries;
    closedir $entries;
    my $known = defined($name) && grep { $_ eq $name } @commands;
    $result = $known
        ? {status => 'route', path => "commands/$name.md", tail => $tail}
        : {status => 'help', commands => \@commands};
}
print JSON::PP->new->utf8->canonical->encode($result), "\n";
