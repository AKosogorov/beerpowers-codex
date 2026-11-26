use strict;
use warnings;
use JSON::PP qw(decode_json);
use Test::More;

for my $locale (qw(en ru)) {
    my $path = "app/locales/$locale.json";
    open my $file, '<:raw', $path or die "$path: $!";
    my $messages = decode_json(do { local $/; <$file> });
    is_deeply([sort keys %$messages], [qw(catalogEmpty catalogTitle)], "$locale catalog messages");
    for my $key (sort keys %$messages) {
        ok(defined($messages->{$key}) && !ref($messages->{$key}) && $messages->{$key} =~ /\S/,
            "$locale has text for $key");
    }
}

done_testing;
