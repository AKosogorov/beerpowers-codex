use strict;
use warnings;
use utf8;

sub session_start {
    my ($event, $package_root, $project, $root, $json) = @_;
    exit 0 if $event->{agent_id} || $event->{agent_type};
    my @rules;
    for my $name (qw(reply_blocking_asks reply_file_links reply_user_shell)) {
        next if lc($ENV{'BEERPOWERS_' . uc $name} // '') eq 'false';
        push @rules, decode('UTF-8', raw_file("$package_root/rules/$name.md"));
    }
    if ($project) {
        push @rules, 'BeerPowers: прочитай .codex/team-charter.md и .codex/team-lead.md из workspace.';
        my $ws = eval { $json->decode(raw_file("$root/.codex/workspace.json")) } // {};
        my $manifest = $json->decode(raw_file("$package_root/.codex-plugin/plugin.json"));
        if ($ws->{beerpowers} && $ws->{beerpowers} ne $manifest->{version}) {
            push @rules, "Workspace создан BeerPowers $ws->{beerpowers}; пакет $manifest->{version}. Проверь совместимость через \$beerpowers doctor.";
        }
    }
    context(@rules);
}

1;
