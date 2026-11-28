# Собирает бриф роли, применимые правила, контекст и проверяемый список источников.
use strict;
use warnings;
use JSON::PP ();
use Encode qw(encode decode);

my @role_names = qw(architect auditor backend database devops explorer frontend implementer product reviewer tester);
# Определяет состав команды по манифестам проекта и выбранному треку.
sub discover_project_team {
    my ($product, $track, $size) = @_;
    my (%seen, %layer);
    my @tracked = split /\0/, git_output('-C', $product, 'ls-files', '--cached', '-z', '--',
        'composer.json', 'package.json', 'supabase/config.toml', '.gitlab-ci.yml',
        ':(glob)**/composer.json', ':(glob)**/package.json', ':(glob)**/supabase/config.toml');
    for my $path (@tracked) {
        next if $path =~ m{(?:\A|/)(?:node_modules|vendor)/};
        my $absolute = safe_path("$product/$path");
        next unless -f $absolute;
        if ($path eq '.gitlab-ci.yml') { $seen{gitlab} = 1; next }
        if ($path =~ m{(?:\A|/)supabase/config\.toml\z}) {
            $seen{supabase} = $seen{postgres} = 1;
            next;
        }
        my $manifest = eval { parse_json(read_file($absolute)) };
        next unless ref($manifest) eq 'HASH';
        my %deps;
        for my $field (qw(require require-dev dependencies devDependencies)) {
            $deps{$_} = 1 for keys %{ref($manifest->{$field}) eq 'HASH' ? $manifest->{$field} : {}};
        }
        if ($deps{'laravel/framework'}) {
            $seen{laravel} = 1;
            $layer{backend} = 1;
        }
        $seen{nuxt} = 1 if $deps{nuxt};
        $layer{frontend} = 1 if grep { $deps{$_} } qw(nuxt next vue react svelte astro @angular/core);
        $layer{backend} = 1 if grep { $deps{$_} } qw(express fastify @nestjs/core symfony/framework-bundle);
        $seen{supabase} = $seen{postgres} = 1 if $deps{'@supabase/supabase-js'};
        $seen{elasticsearch} = 1 if $deps{'@elastic/elasticsearch'} || $deps{'elasticsearch/elasticsearch'};
        $seen{postgres} = 1 if $deps{pg} || $deps{'ext-pdo_pgsql'};
    }
    my @impl;
    push @impl, 'backend' if $layer{backend};
    push @impl, 'frontend' if $layer{frontend};
    push @impl, 'database' if $seen{postgres} && ($size ne 'compact' || @impl < 2);
    my @team = ('architect', @impl, 'tester');
    push @team, 'reviewer' unless $track eq 'pm';
    push @team, 'explorer' if $track ne 'pm' && $size ne 'compact';
    push @team, qw(devops auditor) if $track ne 'pm' && $size eq 'extended';
    push @team, 'product' if $track ne 'dev';
    return {stacks => [sort keys %seen], team => \@team};
}

my $lead_skill_header;
sub apply_lead_skill_header {
    my ($content) = @_;
    return $content if $content =~ /\A---\r?\n/ || !defined $lead_skill_header;
    my $nl = $content =~ /\r\n/ ? "\r\n" : "\n";
    return ($lead_skill_header =~ s/\r?\n/$nl/gr) . $content;
}

sub stage_six_setup {
    my ($package, $version, $product, $json, $products, $legacy_repo, $track, $default_track, $size, $test_inputs, $doctor, $machine_plan, $interactive_plan, $project_label, $rosters, $ui) = @_;
    unless ($doctor) {
        my %detected;
        for my $name (@$products) {
            my $defaults = discover_project_team("projects/$name", $default_track, $size);
            $detected{$name} = $defaults;
            print "Detected stacks (projects/$name): ", join(', ', @{$defaults->{stacks}}), "\n" if $interactive_plan;
        }
        my %params = (slots => 'ROLE_SLOTS', skills => 'ROLE_SKILLS', available => 'SESSION_SKILLS',
            rules => 'PATH_RULES', dependencies => 'SETUP_DEPENDENCIES');
        my %inputs;
        for my $key (keys %params) {
            my $value = $ENV{"BEERPOWERS_$params{$key}_JSON"};
            $inputs{$key} = parse_json($value) if !$machine_plan && defined($value) && length($value);
        }
        my ($input, $arg) = File::Temp::tempfile('beerpowers-role-plan-XXXXX', TMPDIR => 1, UNLINK => 1);
        binmode $input;
        print {$input} $json->encode({detected => \%detected,
            roles => \@role_names, track => $track, inputs => \%inputs, ui => $ui,
            preview => $interactive_plan ? JSON::PP::true : JSON::PP::false, project => decode('UTF-8', $project_label)});
        close $input or die "$arg: $!\n";
        my $node = $ENV{BEERPOWERS_NODE} || 'node';
        my $script = "$package/bin/lib/role-setup.mjs";
        if ($^O eq 'cygwin') {
            $node = Cygwin::win_to_posix_path($node) if $node =~ /^[A-Za-z]:/;
            ($script, $arg) = map { Cygwin::posix_to_win_path($_) } ($script, $arg);
        }
        open my $pipe, '-|', $node, $script, $arg or die "$script: $!\n";
        my $output = do { local $/; <$pipe> };
        close $pipe or die "Не удалось построить план подготовки ролей\n";
        my $plan = parse_json($output);
        %$rosters = %{$plan->{teams}};
        $lead_skill_header = encode('UTF-8', $plan->{leadHeader}) if defined($plan->{leadHeader});
        for my $edit (@{$plan->{changes}}) {
            my $path = safe_path($edit->{path});
            my $content = MIME::Base64::decode_base64($edit->{content});
            if ($edit->{action} eq 'CREATE') { seed($path, $content) }
            elsif ($edit->{action} eq 'UPDATE') { replace_setup_file($path, $content) }
            else { die "Unknown role setup action\n" }
        }
        if ($interactive_plan && (exists($inputs{dependencies}) || @{$plan->{report}})) {
            print "Проект и роль | Зависимость | Причина отсутствия | Способ подключения\n";
            for my $row (@{$plan->{report}}) {
                print encode('UTF-8', "$row->{product}/$row->{role} | $row->{dependency} | $row->{reason} | "),
                    (exists $row->{connection} ? encode('UTF-8', $row->{connection}) : 'Способ подключения не подтверждён'), "\n";
            }
            print "Отсутствующих зависимостей в отчёте нет.\n" unless @{$plan->{report}};
        }
    }
    my @barriers = qw(guard-push guard-kill guard-stdin-code guard-comments guard-commit-split guard-approval-link);
    my %defaults = (map { $_ => JSON::PP::true } @barriers);
    $defaults{'screenshots-reminder'} = JSON::PP::false;
    seed('.codex/barriers.json', $json->encode(\%defaults), sub {
        my $flags = parse_json($_[0]);
        if (ref($flags) eq 'HASH' && exists $flags->{comments}) {
            my $comments = delete $flags->{comments};
            return 0 unless ref($comments) eq 'HASH' && ref($comments->{excludeDirs}) eq 'ARRAY';
            for (@{$comments->{excludeDirs}}) { return 0 unless defined && !ref && length }
        }
        return ref($flags) eq 'HASH' && !grep { !exists $defaults{$_} || !JSON::PP::is_bool($flags->{$_}) } keys %$flags;
    });
    my ($reminders, $previous_by_repo) = ('', {});
    my %retargeted;
    for my $repo (@$products) {
        my $guide = $test_inputs->{$repo}{guide} // "memory/commands/$repo.md";
        my $command = $test_inputs->{$repo}{command};
        my $defaults = discover_project_team("projects/$repo", $track || 'dev', $size);
        my %stack = map { $_ => 1 } @{$defaults->{stacks}};
        my $msg = defined($command) ? "Проверка проекта: $command" : "Проверь применимые гейты из $guide.";
        my $mask = "*/projects/$repo/*|*/worktrees/*/$repo/*";
        $reminders .= "$mask $msg\n";
        my $previous_command = $test_inputs->{$repo}{previous_command};
        if (defined($previous_command) && defined($command) && $previous_command ne $command) {
            $retargeted{"$mask Проверка проекта: $previous_command"} = "$mask $msg";
        }
        $command = $previous_command // $command;
        for my $scope ("*/projects/$repo/", "*/worktrees/*/$repo/") {
            if (defined $command) {
                $previous_by_repo->{$repo} .= "$scope*.vue|$scope*.ts Проверь компоненты и типы: $command\n" if $stack{nuxt};
                $previous_by_repo->{$repo} .= "$scope*database/migrations/*.php Проверь повторный запуск миграции: $command\n" if $stack{laravel};
                $previous_by_repo->{$repo} .= "$scope*.php Проверь PHP: $command\n" if $stack{laravel};
                $previous_by_repo->{$repo} .= "$scope*.sql Проверь миграцию базы: $command\n" if $stack{postgres};
            }
            $previous_by_repo->{$repo} .= "$scope* " . (defined $command ? "Проверка продукта: $command" :
                "Проверь применимые гейты из $guide.") . "\n";
        }
    }
    my $gate_source = '.claude/quality-gates.txt';
    my $initial_gates = $reminders;
    if (!-e '.codex/quality-gates.txt' && -f safe_path($gate_source)) {
        $initial_gates = read_file($gate_source);
        $initial_gates =~ s{\.claude/hooks/quality-reminder\.sh}{quality-reminder.pl}g;
    }
    seed('.codex/quality-gates.txt', $initial_gates,
        sub { 1 });  # An empty file intentionally disables the reminder.
    if (-f '.codex/quality-gates.txt') {
        my $original = read_file('.codex/quality-gates.txt');
        my $existing = $original =~ s{^([^\r\n]+)(?=\r?$)}{$retargeted{$1} // $1}gmer;
        my @prior_sets = ($products);
        push @prior_sets, [$legacy_repo] if defined $legacy_repo;
        for my $set (@prior_sets) {
            my $previous = join('', map {
                my $msg = "Проверь применимые гейты из memory/commands/$_.md.";
                "*/projects/$_/* $msg\n*/worktrees/*/$_/* $msg\n"
            } @$set);
            my $old = join('', @{$previous_by_repo}{@$set});
            if (grep { $existing =~ s/\r\n/\n/gr eq $_ && $_ ne $reminders } ($previous, $old)) {
                replace_setup_file('.codex/quality-gates.txt', $reminders);
                return;
            }
        }
        my $addition = '';
        if (@$products > 1 && defined $legacy_repo) {
            # Only extend the generated first-project defaults.
            my @rules = split /\r?\n/, $reminders;
            my @old = grep { m{/(?:\*/)?\Q$legacy_repo\E/} } @rules;
            if ($existing =~ s/\r\n/\n/gr eq join('', map { "$_\n" } @old)) {
                my @additional = grep { !m{/(?:\*/)?\Q$legacy_repo\E/} } @rules;
                $addition = join('', map { "$_\n" } @additional);
            }
        }
        if ($existing ne $original) {
            $addition =~ s/\n/\r\n/g if $original =~ /\r\n/;
            replace_setup_file('.codex/quality-gates.txt', $existing . $addition);
        } elsif (length $addition) {
            append_lines('.codex/quality-gates.txt', $addition);
        }
    }
}

sub agent_filename { return ($_[0] eq 'tester' ? 'testing' : $_[0]) . '-agent.md' }
sub agent_path { return '.codex/agents/' . agent_filename($_[0]) }

sub role_command {
    my ($package, @args) = @_;
    my $node = $ENV{BEERPOWERS_NODE} || 'node';
    my $script = "$package/bin/role-launch.mjs";
    if ($^O eq 'cygwin') {
        $node = Cygwin::win_to_posix_path($node) if $node =~ /^[A-Za-z]:/;
        $script = Cygwin::posix_to_win_path($script);
    }
    system {$node} $node, $script, @args;
    die "Role command failed: $args[0]\n" if $?;
}
1;
