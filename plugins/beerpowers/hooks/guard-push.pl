use strict;
use warnings;
use utf8;

sub guard_push {
    my ($repo, $root, @args) = @_;
    my (@refs, $remote, $lease, $mr);
    while (@args) {
        my $a = shift @args;
        if ($a =~ /^(?:-o|--push-option)$/) { $mr ||= (($args[0] // '') eq 'merge_request.create'); shift @args; next }
        if ($a =~ /^--push-option=(.*)$/) { $mr ||= $1 eq 'merge_request.create'; next }
        if ($a =~ /^--repo(?:=(.*))?$/) { $remote = $1 // shift @args; next }
        deny('guard-push', 'Укажи явную ветку задачи. Удаление, массовая отправка и слепой force запрещены.')
            if $a =~ /^(?:--force|-[a-z]*[fd][a-z]*|--delete|--all|--branches|--mirror|--prune|--tags)$/;
        if ($a =~ /^--(?:force-with-lease|force-if-includes)(?:=|$)/) { $lease = 1; next }
        if ($a =~ /^--(?:receive-pack|exec)$/) { shift @args; next }
        next if $a =~ /^-/;
        if (defined $remote) { push @refs, $a }
        else { $remote = $a }
    }
    deny('guard-push', 'Укажи remote и каждую ветку назначения явно.') unless @refs;
    opaque() if dynamic_word($remote);
    my $default = git_read($repo, 'symbolic-ref', '--quiet', "refs/remotes/$remote/HEAD");
    chomp $default;
    my $gitlab = git_read($repo, 'config', '--get', "remote.$remote.url") =~ /gitlab/i;
    for my $ref (@refs) {
        deny('guard-push', 'Refspec удаления, wildcard и force запрещены.') if $ref =~ /^[:+]|[*]/;
        opaque() if dynamic_word($ref);
        my ($src, $dst) = split /:/, $ref, 2;
        $dst //= $src;
        $dst =~ s{^refs/heads/}{};
        if ($dst =~ /^(?:HEAD|@)$/) {
            my $branch = git_read($repo, 'symbolic-ref', '--short', '--quiet', 'HEAD');
            chomp $branch;
            deny('guard-push', 'У detached HEAD укажи явное назначение.') unless length $branch;
            $dst = $branch;
        }
        deny('guard-push', "Защищённая ветка $dst. Отправь ветку задачи.")
            if $dst eq 'main' || $dst eq 'master' || $default eq "refs/remotes/$remote/$dst";
        deny('guard-push', "Это дерево пересборки отправляет только ветку $1.")
            if $repo =~ m{/worktrees/chore-([^/]+)-rebuild/} && $dst ne $1;
        my $prior = git_read($repo, 'rev-parse', '--verify', '--quiet', '--end-of-options', "refs/remotes/$remote/$dst^{commit}");
        chomp $prior;
        deny('guard-push', 'Для первого push задачи на GitLab добавь -o merge_request.create.')
            if $gitlab && !$prior && !$mr && ($dst =~ /^[A-Z][A-Z0-9_-]*-\d/ || -d "$root/memory/tasks/$dst");
        next unless $lease && $prior;
        my $next = git_read($repo, 'rev-parse', '--verify', '--quiet', '--end-of-options', "$src^{commit}");
        chomp $next;
        next unless $next;
        my $lost = git_read($repo, 'log', '--no-ext-diff', '--no-textconv', '--no-merges',
            '--cherry-pick', '--left-only', '--format=%h %s', "$prior...$next", '--');
        next unless $lost;
        my $file = state_file('lost-commits', $repo);
        next if seen($file, "$prior:$next");
        remember($file, "$prior:$next");
        deny('guard-push', 'После force исчезнут коммиты. Проверь с человеком перед повтором: ' . substr($lost, 0, 2000));
    }
}

1;
