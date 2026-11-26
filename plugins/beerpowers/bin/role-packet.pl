# Собирает бриф роли, применимые правила, контекст и проверяемый список источников.
use strict;
use warnings;
use JSON::PP ();
use Digest::SHA qw(sha256_hex);
use Encode qw(encode decode FB_CROAK);

my @role_names = qw(architect auditor backend database devops explorer frontend implementer product reviewer tester);
my @stacks = qw(elasticsearch gitlab laravel nuxt postgres supabase);
# Fingerprints of the three historical package defaults after LF normalization.
my %retired_rule = (
    backend => '29b52460efa353d6869477be40b0f0b69fb77a3f41445519663eb8d2e7f0c867',
    frontend => 'c424ba8945c0015559c15e7a5ca89408edf01bce768e25b2d35a8cd36fc0e3b7',
    migrations => '5d2027843e9fa6d4f70ff426b5f474895f57fc245391a633faea9885b8ef21c0',
);
my %role_skills = (
    architect => [qw(brainstorm grill prototype)], auditor => [qw(debug-loop)],
    backend => [qw(debug-loop)], database => [qw(debug-loop)], devops => [qw(debug-loop)],
    explorer => [], frontend => [qw(debug-loop page-screenshot)], implementer => [qw(debug-loop)],
    product => [qw(brainstorm grill prototype tracker-task)], reviewer => [qw(summarizing-mr-links)],
    tester => [qw(debug-loop page-screenshot)], 'team-lead' => [qw(brainstorm grill prototype tracker-task summarizing-mr-links)],
);

# Infer defaults from tracked manifests. Teams can extend the resulting project
# configuration for services discovered through deployment files or project docs.
sub discover_project_rules {
    my ($product, $track, $size) = @_;
    my (%seen, %paths, %layer);
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
            (my $migrations = $path) =~ s{config\.toml\z}{migrations};
            $paths{migrations}{$migrations} = 1;
            next;
        }
        my $manifest = eval { parse_json(read_file($absolute)) };
        next unless ref($manifest) eq 'HASH';
        my %deps;
        for my $field (qw(require require-dev dependencies devDependencies)) {
            $deps{$_} = 1 for keys %{ref($manifest->{$field}) eq 'HASH' ? $manifest->{$field} : {}};
        }
        (my $prefix = $path) =~ s{[^/]+\z}{};
        if ($deps{'laravel/framework'}) {
            $seen{laravel} = 1;
            $layer{backend} = 1;
            $paths{backend}{$prefix . 'app'} = 1;
            $paths{migrations}{$prefix . 'database/migrations'} = 1;
        }
        if ($deps{nuxt}) {
            $seen{nuxt} = 1;
            $paths{frontend}{$prefix . $_} = 1 for qw(app components composables layouts pages plugins);
        }
        $layer{frontend} = 1 if grep { $deps{$_} } qw(nuxt next vue react svelte astro @angular/core);
        $layer{backend} = 1 if grep { $deps{$_} } qw(express fastify @nestjs/core symfony/framework-bundle);
        $seen{supabase} = $seen{postgres} = 1 if $deps{'@supabase/supabase-js'};
        $seen{elasticsearch} = 1 if $deps{'@elastic/elasticsearch'} || $deps{'elasticsearch/elasticsearch'};
        $seen{postgres} = 1 if $deps{pg} || $deps{'ext-pdo_pgsql'};
    }
    my %dirs = map { $_ => [sort keys %{$paths{$_}}] } keys %paths;
    # Git returns UTF-8 bytes. JSON::PP->utf8 expects character strings.
    for my $roots (values %dirs) { $_ = decode('UTF-8', $_, FB_CROAK) for @$roots }
    my @impl;
    push @impl, 'backend' if $layer{backend};
    push @impl, 'frontend' if $layer{frontend};
    push @impl, 'database' if $seen{postgres} && ($size ne 'compact' || @impl < 2);
    my @team = ('architect', @impl, 'tester');
    push @team, 'reviewer' unless $track eq 'pm';
    push @team, 'explorer' if $track ne 'pm' && $size ne 'compact';
    push @team, qw(devops auditor) if $track ne 'pm' && $size eq 'extended';
    push @team, 'product' if $track ne 'dev';
    # The former inferred scopes are retained only to identify unmodified legacy bindings.
    return ({stacks => [sort keys %seen], rules => {}, team => \@team}, \%dirs);
}

sub rule_root_valid {
    my ($path) = @_;
    return defined($path) && !ref($path) && ($path eq '.' ||
        (length($path) && $path !~ m{(?:\A|/)\.{0,2}(?:/|\z)|[\\:*\x00-\x1f]}));
}

sub project_rules_valid {
    my ($config) = @_;
    return 0 unless ref($config) eq 'HASH' && ref($config->{stacks}) eq 'ARRAY' && ref($config->{rules}) eq 'HASH';
    my %valid = map { $_ => 1 } @stacks;
    for (@{$config->{stacks}}) { return 0 unless defined && !ref && delete $valid{$_} }
    if (exists $config->{team}) {
        return 0 unless ref($config->{team}) eq 'ARRAY' && @{$config->{team}};
        my %roles = map { $_ => 1 } @role_names;
        for (@{$config->{team}}) { return 0 unless defined && !ref && delete $roles{$_} }
    }
    if (exists $config->{skills}) {
        return 0 unless ref($config->{skills}) eq 'HASH';
        for my $role (keys %{$config->{skills}}) {
            return 0 unless exists $role_skills{$role} && ref($config->{skills}{$role}) eq 'ARRAY';
            my %seen;
            return 0 if grep { !defined || ref || !/\A[a-z][\w-]*(?::[a-z][\w-]*)?\z/ || $seen{$_}++ } @{$config->{skills}{$role}};
        }
    }
    for my $key (keys %{$config->{rules}}) {
        return 0 unless $key =~ /\A[A-Za-z0-9_-]+\z/ && ref($config->{rules}{$key}) eq 'ARRAY';
        for my $dir (@{$config->{rules}{$key}}) {
            return 0 unless rule_root_valid($dir);
        }
    }
    return 1;
}

sub stage_six_setup {
    my ($package, $version, $product, $json, $products, $legacy_repo, $track, $default_track, $size, $test_inputs, $doctor, $machine_plan, $interactive_plan, $project_label, $rosters) = @_;
    my $role_input = !$doctor && !$machine_plan ? ($ENV{BEERPOWERS_ROLE_SLOTS_JSON} // '') : '';
    my $role_slots = length($role_input) ? parse_json($role_input) : {};
    die "Expected role slots keyed by role\n" unless ref($role_slots) eq 'HASH';
    my %known_roles = map { $_ => 1 } @role_names;
    for my $role (keys %$role_slots) {
        die "Unknown role or invalid slots: $role\n" unless $known_roles{$role} && ref($role_slots->{$role}) eq 'HASH';
    }
    for my $role (grep { $_ ne 'implementer' } @role_names) {
        my $file = agent_path($role);
        my $template = read_file("$package/templates/roles/" . agent_filename($role));
        # Codex Desktop receives this body as a brief. Claude frontmatter does not configure Codex tools.
        $template =~ s/\A---\r?\n[\s\S]*?\r?\n---\r?\n\s*//;
        $template =~ s/\A(?:>[^\n]*\r?\n)+\s*//;
        my %slots = (PROJECT => $project_label);
        for my $name (sort keys %{$role_slots->{$role} // {}}) {
            my $value = $role_slots->{$role}{$name};
            die "Invalid role slot: $role/$name\n"
                unless $name =~ /\A[A-Z][A-Z_]+\z/ && index($template, "{{$name}}") >= 0 &&
                $name ne 'PROJECT' && defined($value) && !ref($value) &&
                $value =~ /\S/ && $value !~ /\x00|\{\{|<!--\s*\/?beerpowers:engine/;
            $slots{$name} = encode('UTF-8', $value);
        }
        $template =~ s/^([^\r\n]*\{\{[A-Z_]+\}\}[^\r\n]*)(\r?\n|\z)/
            my ($line, $ending) = ($1, $2);
            my @names = $line =~ \/\{\{([A-Z_]+)\}\}\/g;
            (grep { !exists $slots{$_} } @names) ? '' :
                (($line =~ s\/\{\{([A-Z_]+)\}\}\/$slots{$1}\/ger) . $ending)
        /gme;
        $template = "# " . agent_filename($role) . "\n\n" . $template unless $template =~ /\A# /;
        my $legacy = safe_path(".codex/roles/$role.md");
        if (-f $legacy && !-f safe_path($file)) {
            my $old = read_file($legacy);
            # Keep hand-written legacy briefs verbatim. Replace package stubs with the full role.
            $template = $old unless $old =~ /Прочитай руководство из \.codex\/roles\/guides\// ||
                $old =~ /Следуй назначенному режиму DESIGN, REVIEW или CONSULT из руководства роли/;
        }
        seed($file, $template);
        seed(".codex/agent-memory/$role/MEMORY.md", read_file("$package/templates/role-memory/MEMORY.md"));
    }
    my @configs = (['.codex/role-settings.json', $product]);
    push @configs, map { [".codex/role-settings/$_.json", "projects/$_"] } @$products if @$products > 1;
    my $assignments = length($ENV{BEERPOWERS_ROLE_SKILLS_JSON} // '') ?
        parse_json($ENV{BEERPOWERS_ROLE_SKILLS_JSON}) : {};
    my $available = length($ENV{BEERPOWERS_SESSION_SKILLS_JSON} // '') ?
        parse_json($ENV{BEERPOWERS_SESSION_SKILLS_JSON}) : undef;
    die "Expected role skill assignments by product and a session inventory array\n"
        unless ref($assignments) eq 'HASH' && (!defined($available) || ref($available) eq 'ARRAY');
    my %available = map { $_ => 1 } @{$available // []};
    my $rules = !$doctor && !$machine_plan && length($ENV{BEERPOWERS_PATH_RULES_JSON} // '') ?
        parse_json($ENV{BEERPOWERS_PATH_RULES_JSON}) : {};
    die "Expected path rules keyed by product\n" unless ref($rules) eq 'HASH';
    my %products = map { $_ => 1 } @$products;
    my $report_input = $interactive_plan ? ($ENV{BEERPOWERS_SETUP_DEPENDENCIES_JSON} // '') : '';
    my $report = length($report_input) ? parse_json($report_input) : [];
    my %reported;
    die "Expected external dependency rows in BEERPOWERS_SETUP_DEPENDENCIES_JSON\n" unless ref($report) eq 'ARRAY';
    for my $row (@$report) {
        die "Expected product, role, dependency, reason and optional connection for each external dependency\n"
            unless ref($row) eq 'HASH' && !grep {
                !defined($row->{$_}) || ref($row->{$_}) || $row->{$_} !~ /\S/ || $row->{$_} =~ /[\r\n\x00|]/
            } (qw(product role dependency reason), exists($row->{connection}) ? 'connection' : ());
        die "Unknown product or role for external dependency\n"
            unless $products{$row->{product}} && grep { $_ eq $row->{role} } ('team-lead', @role_names);
        $reported{join("\0", @{$row}{qw(product role dependency)})} = 1;
    }
    my %new_files;
    for my $name (sort keys %$rules) {
        die "Expected path rules for a known product: $name\n" unless $products{$name} && ref($rules->{$name}) eq 'HASH';
        for my $id (sort keys %{$rules->{$name}}) {
            my $rule = $rules->{$name}{$id};
            die "Expected name, paths and Markdown text for $name/$id\n"
                unless $id =~ /\A[A-Za-z0-9_-]+\z/ && ref($rule) eq 'HASH' &&
                ref($rule->{paths}) eq 'ARRAY' && @{$rule->{paths}} &&
                defined($rule->{text}) && !ref($rule->{text}) && $rule->{text} =~ /\S/ && $rule->{text} !~ /\x00/;
            my %seen;
            for my $path (@{$rule->{paths}}) {
                die "Invalid or duplicate product path for $name/$id\n"
                    unless rule_root_valid($path) && $path ne '.' && !$seen{$path}++;
                my $relative = encode('UTF-8', $path);
                my $target = safe_path("projects/$name/$relative");
                my @tracked = split /\0/, git_output('-C', "projects/$name", '--literal-pathspecs', 'ls-files', '-z', '--', $relative);
                die "Rule path has no tracked files: $name/$path\n"
                    unless (-f $target || -d $target) && grep { $_ eq $relative || index($_, "$relative/") == 0 } @tracked;
            }
            my $file = safe_path(".codex/rules/$id.md");
            my $text = encode('UTF-8', $rule->{text});
            $text .= "\n" unless $text =~ /\n\z/;
            my $prior = $new_files{$id} // (-f $file ? read_file($file) : undef);
            die "Rule conflicts with existing text: $file\n"
                if defined($prior) && ($prior =~ s/\r\n/\n/gr) ne ($text =~ s/\r\n/\n/gr);
            seed($file, $text) unless exists $new_files{$id};
            $new_files{$id} = $text;
        }
    }
    for my $row (@configs) {
        my ($cfg, $scope) = @$row;
        my ($name) = $scope =~ m{/([^/]+)\z};
        my $skills = $assignments->{$name};
        safe_path($cfg);
        my ($defaults, $legacy_paths) = discover_project_rules($scope, $default_track, $size);
        my $existing = -f $cfg;
        my $initial = $existing ? read_file($cfg) :
            defined($legacy_repo) && $cfg eq ".codex/role-settings/$legacy_repo.json" && -f '.codex/role-settings.json'
                ? read_file('.codex/role-settings.json') : $json->encode($defaults);
        my $config = eval { parse_json($initial) };
        if (!project_rules_valid($config)) {
            die "$cfg: inherited role settings are incompatible\n" unless $existing;
            seed($cfg, $initial, sub { 0 });
            next;
        }
        my $before = $json->encode($config);
        if (!$existing && defined $skills) {
            $config->{skills} = $skills;
            die "Invalid skill assignments for $name\n" unless project_rules_valid($config);
            for my $role (sort keys %$skills) {
                die "Unavailable assigned skill for $name/$role\n" if grep { !$available{$_} } @{$skills->{$role}};
            }
        }
        if ($interactive_plan && (@$products == 1 || $cfg ne '.codex/role-settings.json')) {
            for my $role (sort keys %{$config->{skills} // {}}) {
                for my $skill (@{$config->{skills}{$role}}) {
                    next if $available{$skill} || $reported{join("\0", $name, $role, $skill)}++;
                    push @$report, {product => $name, role => $role, dependency => $skill, reason => decode('UTF-8', $available
                        ? 'Навык отсутствует в списке текущего чата' : 'Список навыков текущего чата недоступен')};
                }
            }
        }
        if (length($track) && ref($config->{team}) eq 'ARRAY') {
            my %included = map { $_ => 1 } @{$config->{team}};
            my ($proposed) = discover_project_rules($scope, $track, $size);
            push @{$config->{team}}, grep { !$included{$_} } ($track eq 'pm' ? ('product') : @{$proposed->{team}});
        }
        for my $id (sort keys %{$rules->{$name} // {}}) {
            my $paths = $rules->{$name}{$id}{paths};
            die "Rule conflicts with existing paths: $cfg/$id\n"
                if exists $config->{rules}{$id} && join("\0", sort @{$config->{rules}{$id}}) ne join("\0", sort @$paths);
            $config->{rules}{$id} //= $paths;
        }
        for my $id (keys %{$config->{rules}}) {
            my $file = safe_path(".codex/rules/$id.md");
            next if exists $new_files{$id};
            die "$cfg refers to missing or empty rule: $file\n" unless -f $file && read_file($file) =~ /\S/;
            if (!$doctor && exists $retired_rule{$id} && exists $legacy_paths->{$id} &&
                join("\0", sort @{$config->{rules}{$id}}) eq join("\0", @{$legacy_paths->{$id}}) &&
                sha256_hex(read_file($file) =~ s/\r\n/\n/gr) eq $retired_rule{$id}) {
                delete $config->{rules}{$id};
            }
        }
        my $after = $json->encode($config);
        $rosters->{$name} = $config->{team} // $defaults->{team}
            if @$products == 1 || $cfg ne '.codex/role-settings.json';
        if (!$existing) { seed($cfg, $before eq $after ? $initial : $after) }
        elsif ($before ne $after) { replace_setup_file($cfg, $after) }
    }
    if (length($report_input) || @$report) {
        print "Продукт и роль | Зависимость | Причина отсутствия | Способ подключения\n";
        for my $row (@$report) {
            print encode('UTF-8', "$row->{product}/$row->{role} | $row->{dependency} | $row->{reason} | "),
                (exists $row->{connection} ? encode('UTF-8', $row->{connection}) : 'Способ подключения не подтверждён'), "\n";
        }
        print "Отсутствующих зависимостей в отчёте нет.\n" unless @$report;
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
    my $reminders = '';
    for my $repo (@$products) {
        my $guide = "memory/commands/$repo.md";
        my ($command) = -f $guide ? read_file($guide) =~ /^\x60{3}text\r?\n([^\r\n]+)\r?\n\x60{3}/m : ();
        $command //= $test_inputs->{$repo}{command};
        my ($defaults) = discover_project_rules("projects/$repo", $track || 'dev', $size);
        my %stack = map { $_ => 1 } @{$defaults->{stacks}};
        for my $scope ("*/projects/$repo/", "*/worktrees/*/$repo/") {
            if (defined $command) {
                $reminders .= "$scope*.vue|$scope*.ts Проверь компоненты и типы: $command\n" if $stack{nuxt};
                $reminders .= "$scope*database/migrations/*.php Проверь повторный запуск миграции: $command\n" if $stack{laravel};
                $reminders .= "$scope*.php Проверь PHP: $command\n" if $stack{laravel};
                $reminders .= "$scope*.sql Проверь миграцию базы: $command\n" if $stack{postgres};
            }
            $reminders .= "$scope* " . (defined $command ? "Проверка продукта: $command" : "Проверь применимые гейты из $guide.") . "\n";
        }
    }
    seed('.codex/quality-gates.txt', $reminders,
        sub { 1 });  # An empty file intentionally disables the reminder.
    if (-f '.codex/quality-gates.txt') {
        my $existing = read_file('.codex/quality-gates.txt');
        my @prior_sets = ($products);
        push @prior_sets, [$legacy_repo] if defined $legacy_repo;
        for my $set (@prior_sets) {
            my $previous = join('', map {
                my $msg = "Проверь применимые гейты из memory/commands/$_.md.";
                "*/projects/$_/* $msg\n*/worktrees/*/$_/* $msg\n"
            } @$set);
            if ($existing =~ s/\r\n/\n/gr eq $previous && $previous ne $reminders) {
                replace_setup_file('.codex/quality-gates.txt', $reminders);
                return;
            }
        }
        return unless @$products > 1 && defined $legacy_repo;
        # Only extend the generated first-product defaults. Preserve custom ordering and empty files.
        my @rules = split /\r?\n/, $reminders;
        my @old = grep { m{/(?:\*/)?\Q$legacy_repo\E/} } @rules;
        if ($existing =~ s/\r\n/\n/gr eq join('', map { "$_\n" } @old)) {
            my @additional = grep { !m{/(?:\*/)?\Q$legacy_repo\E/} } @rules;
            append_lines('.codex/quality-gates.txt', join('', map { "$_\n" } @additional)) if @additional;
        }
    }
}

sub agent_filename { return ($_[0] eq 'tester' ? 'testing' : $_[0]) . '-agent.md' }
sub agent_path { return '.codex/agents/' . agent_filename($_[0]) }

sub role_packet {
    my ($package, $repo, $role, @paths) = @_;
    die "Unknown role: use team-lead or one of @role_names\n" unless defined($role) && exists $role_skills{$role};
    for (@paths) {
        die "Expected a product-relative path: $_\n" if !length || m{\A/|/\z|//|(?:\A|/)\.{1,2}(?:/|\z)|[\\:\x00-\x1f]};
    }
    my @files = ('.codex/team-charter.md', 'memory/MEMORY.md', "memory/commands/$repo.md");
    push @files, 'memory/project/domain-invariants.md'
        if $role ne 'explorer' && -f safe_path('memory/project/domain-invariants.md');
    if ($role eq 'team-lead') { push @files, '.codex/team-lead.md' }
    else {
        my $agent = agent_path($role);
        push @files, -f safe_path($agent) ? $agent : ".codex/roles/$role.md";
        my $dir = safe_path(".codex/agent-memory/$role");
        opendir my $memory, $dir or die "$dir: $!\n";
        push @files, "$dir/MEMORY.md", map { "$dir/$_" } sort grep { /\Afeedback_[^\/\\]+\.md\z/ } readdir $memory;
        closedir $memory;
    }
    my $scope = safe_path(".codex/role-settings/$repo.json");
    my $config = parse_json(read_file(-f $scope ? $scope : '.codex/role-settings.json'));
    print "Roster: ", join(', ', @{$config->{team}}), "\n" if ref($config->{team}) eq 'ARRAY';
    print "Assigned skills ($role): ", join(', ', @{$config->{skills}{$role}}), "\n"
        if ref($config->{skills}{$role}) eq 'ARRAY';
    for my $rule (sort keys %{$config->{rules}}) {
        my $roots = $config->{rules}{$rule};
        next unless grep {
            my $prefix = encode('UTF-8', $_);
            !@paths || $prefix eq '.' || grep { $_ eq $prefix || index($_, "$prefix/") == 0 } @paths
        } @$roots;
        push @files, ".codex/rules/$rule.md";
    }
    for my $path (@files) {
        my $content = read_file(safe_path($path));
        print "\nFILE $path sha256=", sha256_hex($content), "\n$content\n";
    }
    for my $skill ('minimal-diff', 'economy', @{$role_skills{$role}}) {
        my $path = "$package/skills/$skill/SKILL.md";
        my $content = read_file($path);
        my $label = $^O eq 'cygwin' ? Cygwin::posix_to_win_path($path, 1) : $path;
        $label =~ tr{\\}{/} if $^O eq 'cygwin';
        print "\nFILE $label sha256=", sha256_hex($content), "\n$content\n";
    }
}
1;
