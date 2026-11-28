# Переносит адреса инструкций в проектной памяти. Для исторической ссылки
# подтверждает и старый файл, и строку отчёта объектами одного архивного коммита.
use strict;
use warnings;

sub memory_archive {
    my ($head) = @_;
    my @candidates = git_output('for-each-ref', '--format=%(objectname)', 'refs/heads/archive/beerpowers-claude') =~ /^([0-9a-f]{40,64})$/mg;
    push @candidates, $head;
    my $parent = git_output('log', '-1', '--format=%P', '--diff-filter=A', $head, '--', '.codex/team-charter.md');
    push @candidates, $1 if $parent =~ /^([0-9a-f]{40,64})\b/;
    my %seen;
    for my $sha (grep { !$seen{$_}++ } @candidates) {
        next if $sha ne $head && system('git', 'merge-base', '--is-ancestor', $sha, $head) != 0;
        my $items = git_output('ls-tree', '-r', '-z', $sha, '--', '.claude/team-charter.md', '.claude/team-lead.md',
            '.claude/workspace.json', '.claude/agents', '.claude/rules', '.claude/reference', 'memory/tasks');
        my %blobs = map { /^100[0-7]+ blob ([0-9a-f]+)\t(.+)$/s ? ($2 => $1) : () } split /\x00/, $items;
        return ($sha, \%blobs) if exists $blobs{'.claude/team-charter.md'};
    }
    return;
}

sub migrate_memory_links {
    my ($bin, $changes, $package_url) = @_;
    return unless -f safe_path('memory/MEMORY.md');
    open my $ref, '-|', 'git', 'rev-parse', '--verify', '-q', 'HEAD' or die "git: $!\n";
    my $head = <$ref> // '';
    return unless close($ref) && $head =~ s/\s+$//;
    my ($sha, $blobs) = memory_archive($head);
    $blobs //= {};
    my %pending = map { $_->[0] => $_ } @$changes;
    my (%target, %basename);
    for my $old (sort keys %$blobs) {
        next unless $old =~ m{^\.claude/((?:team-(?:charter|lead)\.md|workspace\.json)|(?:agents|rules|reference)/[a-zA-Z0-9_./-]+\.md)$};
        my $suffix = $1;
        my $dest = ".codex/$suffix";
        if ($suffix =~ m{^reference/}) {
            next unless -f "$bin/../$suffix";
            $dest = 'beerpowers:' . $suffix;
        } else {
            next unless $pending{$dest} || -f safe_path($dest);
        }
        $target{$old} = $dest;
        push @{$basename{basename($old)}}, $old unless $suffix =~ m{^reference/};
    }
    my %docs = map { $_ => 1 } ('memory/MEMORY.md', split /\x00/, git_output('ls-files', '-z', '--', 'memory'));
    for my $file (sort keys %docs) {
        next unless $file =~ /\.md\z/ && $file !~ m{^memory/tasks/.*?/(?:tracker|screenshots|figma)/} &&
            $file !~ m{(?:^|/)feedback_[^/]*\.md$};
        next unless -f safe_path($file);
        my $before = read_file($file);
        my $change = $pending{$file};
        my $body = !$change ? $before : ($change->[3] // '') eq 'replace' ? $change->[2] : $before . $change->[2];
        my $historical = $file =~ m{^memory/tasks/};
        next if $historical && !exists $blobs->{$file};
        my @lines = split /(?<=\n)/, $body;
        my (%archived_lines, $loaded, $comment);
        for my $i (prose_line_indices(\@lines)) {
            my $line = $lines[$i];
            if ($comment || $line =~ /<!--/) {
                $comment = $line !~ /-->/;
                next;
            }
            unless ($historical) {
                # Меняем только известные команды пакета. Локальные Claude-скрипты
                # проекта и команды из архивных отчётов сохраняют свои адреса.
                $lines[$i] =~ s{\x60node (?:\.claude|<пакет>)/bin/([\w-]+\.mjs)(?=[\s\x60])}{
                    -f "$bin/$1" ? "\x60node \"\$packageRoot/bin/$1\"" : $&
                }ge;
                $lines[$i] =~ s{\x60(?:\.claude/bin/workspace-clean|"\$packageRoot/bin/workspace-clean")(?=[\s\x60])}{`node "\$packageRoot/bin/workspace-clean"}g;
                $lines[$i] =~ s{\x60\.claude/bin/figma-export(?= )}{`node "\$packageRoot/bin/figma-export.mjs"}g;
                $lines[$i] =~ s{\x60\.claude/bin/yandex-tracker (\S+) --comments --save memory/tasks/\1/tracker\x60}{`node "\$packageRoot/bin/tracker.mjs" sync $1`}g;
                if ($file eq 'memory/tech-debt/tech-debt.md') {
                    $lines[$i] =~ s{скриптом \.claude/bin/tech-debt-index\.mjs}{скриптом tech-debt-index.mjs из установленного BeerPowers};
                    $lines[$i] =~ s{^тот же скрипт с `--check`\. Правки руками здесь затираются\.}{`node "\$packageRoot/bin/workspace-check.mjs"`. Текст вне управляемой таблицы сохраняется.};
                    next;
                }
                my $name = qr{reference/(?:[\w-]+/)*[\w-]+\.md};
                # Только самостоятельный адрес пакета или явная пометка о поставке.
                $lines[$i] =~ s{\]\((?:\$packageRoot/|beerpowers:)($name)(\#[^\s)]*)?\)}{
                    my ($file, $fragment) = ($1, $2 // '');
                    -f "$bin/../$file" ? qq{]($package_url/$file$fragment "beerpowers:$file$fragment")} : $&
                }ge;
                $lines[$i] =~ s{\x60\$packageRoot/($name)(?=[#\x60])}{
                    -f "$bin/../$1" ? "\x60beerpowers:$1" : $&
                }ge;
                $lines[$i] =~ s{(?<![.:/\w-])($name)(?=\x60? установленного пакета)}{
                    -f "$bin/../$1" ? 'beerpowers:' . $1 : $&
                }ge;
            }
            next unless $line =~ /\x60/;
            $lines[$i] =~ s{(?<!\x60)\x60([.\w/-]+)\x60(?!\x60)}{
                my ($token, $original) = ($1, $&);
                my $old = exists($target{$token}) ? $token : undef;
                if (!$old && $basename{$token} && @{$basename{$token}} == 1 &&
                    !-e safe_path(dirname($file) . '/' . $token)) {
                    $old = $basename{$token}[0];
                }
                my $replacement = $original;
                if ($old && !$historical) {
                    $replacement = "\x60$target{$old}\x60";
                } elsif ($old && $historical && $old ne $token) {
                    # Явный исторический путь и команды остаются как записаны. У
                    # неоднозначного короткого имени появляется проверяемый адрес.
                    if (!$loaded) {
                        %archived_lines = map { $_ => 1 } split /\r?\n/, git_output('cat-file', 'blob', $blobs->{$file});
                        $loaded = 1;
                    }
                    $replacement = "\x60$sha:$old\x60" if $archived_lines{$line =~ s/\r?\n\z//r};
                }
                $replacement;
            }gex;
        }
        my $updated = join('', @lines);
        if ($updated ne $body) {
            if ($change) { @$change = ($file, $before, $updated, 'replace') }
            else { push @$changes, [$file, $before, $updated, 'replace'] }
        }
    }
}
1;
