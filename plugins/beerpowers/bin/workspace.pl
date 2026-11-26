# Планирует и применяет setup, готовит проектные настройки и служебные команды BeerPowers.
use strict;
use warnings;
use Cwd qw(getcwd);
use File::Basename qw(basename dirname);
use File::Path qw(make_path);
use File::Find ();
use File::Temp qw(tempfile);
use Encode qw(encode decode FB_CROAK LEAVE_SRC);
use MIME::Base64 qw(encode_base64);
# PowerShell passes a Windows script path to Git for Windows' POSIX Perl.
BEGIN { $0 = Cygwin::win_to_posix_path($0) if $^O eq 'cygwin' && $0 =~ /\\/ }
use FindBin qw($Bin);
use Fcntl qw(:DEFAULT :flock SEEK_END);
use JSON::PP;

my $mode = shift // '';
my $usage = <<'USAGE';
workspace.pl plan|apply|doctor
workspace.pl task-plan|task-start TASK [options]
workspace.pl review-diff TASK BASE_SHA TESTED_SHA
workspace.pl handover TASK pause|check|clear
workspace.pl feature-state TASK [EVENT]
workspace.pl role-packet ROLE [PRODUCT_RELATIVE_PATH...]
USAGE
if ($mode eq '--help' || (@ARGV == 1 && $ARGV[0] eq '--help' && $mode =~ /\A(?:plan|apply|doctor|task-plan|task-start|review-diff|handover|feature-state|role-packet)\z/)) {
    print $usage;
    exit 0;
}
my $machine_plan = $mode eq 'plan-json';
if ($machine_plan) {
    $mode = 'plan';
    select STDERR;  # Keep the public diagnostics separate from literal file contents.
}
my $task = $mode eq 'task-start' || $mode eq 'task-plan';
my $review = $mode eq 'review-diff';
my $handover = $mode eq 'handover';
my $feature = $mode eq 'feature-state';
my $packet = $mode eq 'role-packet';
my $operation = $task || $review || $handover || $packet || $feature;
die "Usage: $usage"
    unless $operation || (!@ARGV && $mode =~ /\A(plan|apply|doctor)\z/);
my $command = $ENV{BEERPOWERS_TEST_COMMAND} // '';
my $source = $ENV{BEERPOWERS_TEST_SOURCE} // '';
my $doctor = $mode eq 'doctor' || $operation;
$ENV{GIT_OPTIONAL_LOCKS} = 0 if $operation;
my $json = JSON::PP->new->utf8->canonical->pretty;
my (@changes, @errors);

sub read_file {
    my ($path) = @_;
    open my $file, '<:raw', $path or die "$path: $!\n";
    local $/;
    return scalar(<$file>) // '';
}

sub parse_json {
    my ($content) = @_;
    $content =~ s/^\xef\xbb\xbf//;
    return $json->decode($content);
}

# Resolve generated paths relative to this workspace, including existing parents.
sub safe_path {
    my ($path) = @_;
    my $part = '';
    for (split m{/}, $path) {
        die "Invalid relative path: $path\n" if /^(?:\.{0,2})$/ || /[\\:\x00-\x1f]/;
        $part .= ($part eq '' ? '' : '/') . $_;
        die "Linked path: $part\n" if -l $part;
        die "Expected directory: $part\n" if $part ne $path && -e $part && !-d $part;
    }
    return $path;
}

sub git_output {
    open my $pipe, '-|', 'git', @_ or die "git: $!\n";
    local $/;
    my $output = <$pipe> // '';
    close $pipe or die "git @_ failed\n";
    return $output;
}

die "Open the outer Git workspace containing projects/<repo>/\n"
    unless -e '.git' && git_output('rev-parse', '--show-prefix') =~ /^\s*$/ && -d safe_path('projects');
opendir my $projects, 'projects' or die "projects: $!\n";
my @repos = sort grep { $_ ne '.' && $_ ne '..' && -e "projects/$_/.git" } readdir $projects;
closedir $projects;
die "Expected Git repositories in projects/\n" unless @repos;
for my $name (@repos) {
    die "Unsupported repository name: $name\n" unless $name =~ /\A[A-Za-z0-9_][A-Za-z0-9_.-]*\z/;
    my $path = safe_path("projects/$name");
    safe_path("$path/.git");
    die "Invalid product checkout: $path\n" unless git_output('-C', $path, 'rev-parse', '--show-prefix') =~ /^\s*$/;
}
my $repo = $operation && length($ENV{BEERPOWERS_REPO} // '') ? $ENV{BEERPOWERS_REPO} : $repos[0];
die "Unknown selected product: $repo\n" unless grep { $_ eq $repo } @repos;
my $product = safe_path("projects/$repo");
die "Outer Git already tracks projects/ or worktrees/. Review its index before setup.\n"
    if length git_output('ls-files', '--', 'projects/', 'worktrees/');
my $manifest = parse_json(read_file("$Bin/../.codex-plugin/plugin.json"));
my $version = $manifest->{version};
print "Workspace: ", getcwd(), "\nRoles: explicit Markdown briefs\n";
print "Role binding: project .codex/agents/<role>-agent.md in the Desktop spawn brief; write limits are instructions.\n"
    if $mode eq 'doctor';

print "Existing memory/ preserved; setup may add missing files and approved index rows.\n" if -d 'memory';

sub source_exists {
    my ($product, $path) = @_;
    return defined($path) && length($path) && $path !~ /[\r\n\x60]/ && -f safe_path("$product/$path");
}

sub legacy_npm_gate {
    my ($prose, $product) = @_;
    my @sections = $prose =~ /^ {0,3}##[ \t]+Гейты[ \t]*\n(.*?)(?=^ {0,3}#{1,2}[ \t]|\z)/msg;
    my @gates = grep { /\A[ \t]*npm(?:[ \t]|\z)/ }
        ($sections[0] // '') =~ /(?<!\x60)\x60([^\x60\n]+)\x60(?!\x60)/g;
    die "ambiguous npm gate in section Гейты\n" if @sections > 1 || @gates > 1;
    die "missing inline npm gate in section Гейты\n" unless @gates;

    # Разбираем только литералы и известную обёртку логирования.
    my $word = qr{[-A-Za-z0-9_./:=+,@%]+};
    my $log_path = qr{(?:$word|<[^<>\x60\r\n]+>)};
    my ($invocation, $log, $status_log) = trim_cell($gates[0]) =~
        /\A([^>]+?)(?:[ \t]*>[ \t]*($log_path)[ \t]+2>&1[ \t]*;[ \t]*echo[ \t]+CODE=\$\?[ \t]*>>[ \t]*($log_path))?\z/;
    die "unsupported npm gate redirection\n" unless defined $invocation;
    die "npm gate must write output and CODE to the same log\n" if defined($log) && $log ne $status_log;

    my ($prefix, $script, $args) = trim_cell($invocation) =~
        /\Anpm[ \t]+--prefix[ \t]+($word)[ \t]+run[ \t]+([A-Za-z0-9_][-A-Za-z0-9_.:]*)((?:[ \t]+$word)*)\z/;
    die "unsupported npm gate; expected npm --prefix <product> run <script> [args]\n" unless defined $prefix;
    die "npm --prefix points to $prefix, expected $product\n" unless $prefix =~ m{\A(?:\./)?\Q$product\E/?\z};
    my @args = split ' ', $args;
    for my $arg (@args) {
        last if $arg eq '--';
        die "unsupported npm gate option $arg before --\n" if $arg =~ /^-/;
    }
    return (join(' ', 'npm', 'run', $script, @args), $script);
}

sub validate_test_guide {
    my ($doc, $product, $command, $source) = @_;
    $doc =~ s/\r\n/\n/g;
    $doc =~ s/\A\xef\xbb\xbf//;
    my $prose = markdown_prose($doc);
    $prose =~ s/<!--.*?(?:-->|\z)//gs;
    my ($saved, $evidence, $script);
    if ($prose =~ /^(?:Каталог запуска|Источник):/m) {
        ($saved) = $doc =~ /^\x60{3}text\n([^\n]+)\n\x60{3}$/m;
        ($evidence) = $doc =~ /^Источник: \x60([^\x60\n]+)\x60$/m;
        die "expected launch directory $product/\n" unless $doc =~ /^Каталог запуска: \x60\Q$product\E\/\x60$/m;
        die "missing or invalid single-line command in fenced text block\n"
            unless defined($saved) && $saved =~ /\S/ && $saved !~ /[\r\n\x00]/;
        die "missing source in Codex command note\n" unless defined $evidence;
    } else {
        ($saved, $script) = legacy_npm_gate($prose, $product);
        $evidence = 'package.json';
        $command = trim_cell($command) =~ s/[ \t]+/ /gr if defined $command;
    }
    die "source differs from setup input; expected $evidence, got $source\n" if defined($source) && $source ne $evidence;
    die "command or arguments differ from setup input; expected $command, found $saved\n"
        if defined($command) && $command ne $saved;
    die "test source missing in $product: $evidence\n" unless source_exists($product, $evidence);
    if (defined $script) {
        my $manifest = eval { parse_json(read_file("$product/$evidence")) };
        die "invalid JSON object in $product/$evidence\n" unless ref($manifest) eq 'HASH';
        my $scripts = $manifest->{scripts};
        my $definition = ref($scripts) eq 'HASH' ? $scripts->{$script} : undef;
        die "missing scripts.$script in $product/$evidence\n" unless defined $definition;
        die "invalid scripts.$script in $product/$evidence; expected a non-empty string\n"
            unless !ref($definition) && $json->encode($definition) =~ /\A"/ && $definition =~ /\S/;
    }
    return ($saved, $evidence);
}

my $git_file = safe_path('.codex/git-settings.json');
my $git_settings = -f $git_file ? eval { parse_json(read_file($git_file)) } :
    {standArchive => JSON::PP::false, removeSourceBranch => JSON::PP::true, repos => {}};
die "Expected repos object in $git_file\n" unless ref($git_settings) eq 'HASH' && ref($git_settings->{repos}) eq 'HASH';
for my $key (qw(standArchive removeSourceBranch)) {
    die "$git_file: $key must be boolean\n" if exists($git_settings->{$key}) && !JSON::PP::is_bool($git_settings->{$key});
}
my %existing_profiles = %{$git_settings->{repos}};
my %test_inputs;
my $checks_json = $doctor ? '' : ($ENV{BEERPOWERS_TESTS_JSON} // '');
my $read_saved_checks = $doctor || ($machine_plan && !length($checks_json));
if (length $checks_json) {
    my $input = parse_json($checks_json);
    die "BEERPOWERS_TESTS_JSON must map every product to its command, source and profile\n"
        unless ref($input) eq 'HASH' && keys(%$input) == @repos;
    %test_inputs = %$input;
} elsif (!$read_saved_checks && @repos == 1) {
    $test_inputs{$repo} = {command => $command, source => $source};
} elsif (!$read_saved_checks) {
    die "Set BEERPOWERS_TESTS_JSON with checks for every product: @repos\n";
}
for my $name (@repos) {
    my $product = "projects/$name";
    my $params = $test_inputs{$name} // {};
    die "Invalid checks for $name\n" unless ref($params) eq 'HASH';
    my $profile = $params->{profile} // $existing_profiles{$name} // 'main-default';
    die "Invalid Git profile for $name\n" unless $profile =~ /\A(?:main-default|dev-default|custom)\z/;
    die "$git_file: existing profile differs for $name; reconcile explicitly\n"
        if exists $existing_profiles{$name} && $existing_profiles{$name} ne $profile;
    if ($doctor && !exists $existing_profiles{$name}) { push @errors, "$git_file: missing profile for $name" }
    $git_settings->{repos}{$name} = $profile;
    print "Product: $product\nProfile: $profile\n";
    my $guide = safe_path("memory/commands/$name.md");
    my ($cmd, $src) = @{$params}{qw(command source)};
    if (!$read_saved_checks) {
        die "Expected non-empty test command for $name\n" unless defined($cmd) && !ref($cmd) && $cmd =~ /\S/ && $cmd !~ /[\r\n\x00]/;
        die "$guide: Test source missing in $product\n" unless defined($src) && !ref($src) && length($src);
        # JSON::PP decodes JSON to characters. Existing Perl documents contain UTF-8 bytes.
        ($cmd, $src) = map { encode('UTF-8', $_) } ($cmd, $src) if length $checks_json;
    }
    if (-f $guide) {
        my $ok = eval { ($cmd, $src) = validate_test_guide(read_file($guide), $product, $cmd, $src); 1 };
        unless ($ok) {
            my $reason = $@;
            chomp $reason;
            push @errors, "$guide: $reason";
            next;
        }
    } elsif ($read_saved_checks) {
        push @errors, "$guide: expected a regular file";
        next;
    } else {
        die "$guide: Test source missing in $product: $src\n" unless source_exists($product, $src);
    }
    @{$test_inputs{$name}}{qw(command source)} = ($cmd, $src);
    print "Tests (cwd $product): $cmd\nSource: $src\n" unless $doctor;
}

# Existing documents belong to the project. Validate them and only seed missing files.
sub seed {
    my ($path, $initial, $validate) = @_;
    safe_path($path);
    if (-f $path) {
        my $content = read_file($path);
        my $ok = eval { $validate ? $validate->($content) : $content =~ /\S/ };
        push @errors, "$path: empty or incompatible content; review existing file" unless $ok;
    } elsif (-e $path || $doctor) {
        push @errors, "$path: expected a regular file";
    } else {
        push @changes, [$path, undef, $initial];
    }
}

my $workspace_file = safe_path('.codex/workspace.json');
my $current_setup = !-e $workspace_file ||
    eval { (parse_json(read_file($workspace_file))->{beerpowers} // '') eq $version };
my $track = !$doctor && !$machine_plan ? ($ENV{BEERPOWERS_TRACK} // '') : '';
die "BEERPOWERS_TRACK must be dev, pm or both\n" if length($track) && $track !~ /\A(?:dev|pm|both)\z/;
my $size = !$doctor && !$machine_plan ? ($ENV{BEERPOWERS_TEAM_SIZE} // 'standard') : 'standard';
die "BEERPOWERS_TEAM_SIZE must be compact, standard or extended\n" unless $size =~ /\A(?:compact|standard|extended)\z/;
my $intake = !$doctor && !$machine_plan ? ($ENV{BEERPOWERS_INTAKE} // '') : '';
die "BEERPOWERS_INTAKE must be plan, stages or autonomous\n" unless $intake =~ /\A(?:plan|stages|autonomous)?\z/;
my $pm_section = <<'PM';
## PM-конвейер

Продуктовая роль product ведёт intake, PRD, декомпозицию, оценку и план. Для одной небольшой фазы без развилок достаточно feature-brief. Артефакты и подтверждения живут в docs/features/<slug>/. Статусы идут от Draft через Approved и In Development до Done. После handoff разработчик берёт утверждённый план через task-start. Условия переходов и handoff — в reference/feature-pipeline.md#артефакты-и-статусы установленного пакета.

В PM-состав входят product, architect и владельцы затронутых слоёв, включая tester по необходимости. На консультации технические роли читают исходники и передают пути, риски и оценки S/M/L/XL с уверенностью и доказательствами. Перед разработкой нужен dev-состав с финальным reviewer.
PM
my $dev_section = <<'DEV';
## Команда разработки

Тимлид ведёт постановку, Git и передачу по гейтам. Маршрут выбирается по классу задачи. Действующие роли и источники для них приведены в таблице «Состав».
DEV

sub engine_template {
    my ($name) = @_;
    my %paths = (entry => 'AGENTS.md', 'memory-index' => 'memory/MEMORY.md');
    my %markers = (entry => 'entry', 'memory-index' => 'codex-memory');
    my $path = $paths{$name} // "charter/$name.md";
    my $marker = $markers{$name} // ($name eq 'team-lead' ? 'codex-lead' : 'codex-team');
    my $body = read_file("$Bin/../templates/$path");
    $body =~ s/\r\n/\n/g;
    my ($block) = $body =~ /^(<!-- beerpowers:engine \Q$marker\E -->\n[\s\S]*?^<!-- \/beerpowers:engine -->\n?)/m;
    die "Missing managed block $marker in $path\n" unless defined $block;
    return $block;
}

# Fenced examples describe a configuration without activating its headings or markers.
sub markdown_prose {
    my ($text) = @_;
    $text =~ s/\A\xef\xbb\xbf//;
    my ($fence, @lines);
    for my $line (split /\r?\n/, $text) {
        if (defined $fence) {
            my $char = substr($fence, 0, 1);
            undef $fence if $line =~ /^ {0,3}\Q$fence\E\Q$char\E*[ \t]*$/;
        } elsif ($line =~ /^ {0,3}(`{3,}|~{3,})/) {
            $fence = $1;
        } else {
            push @lines, $line;
        }
    }
    return join("\n", @lines);
}

my $saved_workspace = -f $workspace_file ? parse_json(read_file($workspace_file)) : undef;
my $project_input = !$doctor && !$machine_plan ? $ENV{BEERPOWERS_PROJECT_NAME} : undef;
my $saved_label = ref($saved_workspace) eq 'HASH' ? $saved_workspace->{projectName} : undef;
my $project_name = defined($project_input) ? decode('UTF-8', $project_input, FB_CROAK | LEAVE_SRC) : $saved_label //
    decode('UTF-8', @repos == 1 ? $repo : basename(getcwd()), FB_CROAK | LEAVE_SRC);
die "Expected a single-line project name\n" if ref($project_name) || !length($project_name) ||
    $project_name =~ /\A\s|\s\z|[\x00-\x1f\x7f<>{}]/;
die "Project name differs from saved workspace name\n" if defined($saved_label) && $project_name ne $saved_label;
my $label = encode('UTF-8', $project_name);
my $roster_track = $track;
my $default_track = $track || 'dev';
my %charter_fields = (
    'team-charter' => {map { $_ => 1 } qw(PURPOSE STACK_TABLE COMMANDS ROLES_TABLE MODELS PROJECT_RULES UNIVERSAL_SKILLS MEMORY_FILES_EXTRA)},
    'team-lead' => {map { $_ => 1 } qw(CLASS_EXTRA EFFORT_TABLE MODEL_EXTRA GATES_EXTRA CLOSING_EXTRA)},
);
my %charter_notes;
if (!$doctor && !$machine_plan && length($ENV{BEERPOWERS_CHARTER_SLOTS_JSON} // '')) {
    my $input = parse_json($ENV{BEERPOWERS_CHARTER_SLOTS_JSON});
    die "Expected charter slots keyed by template\n" unless ref($input) eq 'HASH';
    for my $name (sort keys %$input) {
        die "Unknown charter template $name\n" unless $charter_fields{$name} && ref($input->{$name}) eq 'HASH';
        for my $slot (sort keys %{$input->{$name}}) {
            my $value = $input->{$name}{$slot};
            die "Invalid charter slot $name/$slot\n" unless $charter_fields{$name}{$slot} &&
                defined($value) && !ref($value) && $value =~ /\S/ && $value !~ /\x00|\{\{|<!--\s*\/?beerpowers:engine/;
            $value =~ s/\s+\z//;
            $charter_notes{$name}{$slot} = encode('UTF-8', $value);
        }
    }
}
sub render_sections {
    my ($body, $slots) = @_;
    $body =~ s/^\{\{([A-Z_]+)\}\}\r?\n/exists $slots->{$1} ? "$slots->{$1}\n" : ''/gme;
    return $body;
}
my $roster_header = '| Роль | Продукты | Read on spawn |';
my $command_index_header = '| Файл | Что внутри | Кому |';
sub trim_cell { return $_[0] =~ s/^[ \t]+|[ \t]+$//gr }
sub table_cells {
    my ($line) = @_;
    $line =~ s/\r?\n\z//;
    $line =~ s/^ {0,3}\|//;
    $line =~ s/(?<!\\)\|[ \t]*$//;
    return split /(?<!\\)\|/, $line, -1;
}
sub fill_table_row {
    my ($cells, $positions, $values) = @_;
    @{$cells}[@$positions] = map { " $_ " } @$values;
    return '|' . join('|', map { $_ // ' ' } @$cells) . '|';
}
sub roster_row {
    my ($role, @products) = @_;
    my $brief = $role eq 'implementer' && !-f agent_path($role) ? ".codex/roles/$role.md" : agent_path($role);
    my @read = ("`$brief`", '`memory/MEMORY.md`', '`memory/project/domain-invariants.md`', '`memory/project/safety-rules.md`');
    push @read, '`memory/project/project-map.md`' unless $role eq 'tester' || $role eq 'reviewer';
    push @read, '`memory/tests/probes.md`' if $role eq 'tester';
    push @read, '`memory/product-*.md` (если созданы)' if $role eq 'product';
    push @read, map { "`memory/commands/$_.md`" } @products;
    return "| `$role` | " . join(', ', @products) . ' | ' . join(', ', @read) . ' |';
}
sub roster_rows {
    my ($rosters) = @_;
    my %products;
    for my $name (sort keys %$rosters) {
        push @{$products{$_}}, $name for @{$rosters->{$name}};
    }
    return map { $_ => roster_row($_, @{$products{$_}}) } keys %products;
}
sub edit_setup_table {
    my ($body, $header, $section, $edit) = @_;
    my @required = map { trim_cell($_) } table_cells($header);
    my @lines = split /(?<=\n)/, $body;
    my $active = !defined $section;
    my $fence;
    for my $i (0 .. $#lines - 1) {
        my $line = $lines[$i] =~ s/\r?\n\z//r;
        if ($fence) {
            my $char = substr($fence, 0, 1);
            undef $fence if $line =~ /^ {0,3}\Q$fence\E\Q$char\E*[ \t]*$/;
            next;
        }
        if ($line =~ /^ {0,3}(`{3,}|~{3,})/) {
            $fence = $1;
            next;
        }
        $active = $line eq $section if defined($section) && $line =~ /^#{1,2} /;
        next unless $active && $line =~ /^ {0,3}\|/;
        my @columns = map { trim_cell($_) } table_cells($line);
        my @delimiter = map { trim_cell($_) } table_cells($lines[$i + 1]);
        next unless @columns == @delimiter && !grep { !/^:?-{3,}:?$/ } @delimiter;
        my %positions;
        for my $index (0 .. $#columns) {
            $positions{$columns[$index]} = exists $positions{$columns[$index]} ? undef : $index;
        }
        next if grep { !defined $positions{$_} } @required;
        my $start = $i + 2;
        my $end = $start;
        $end++ while $end <= $#lines && $lines[$end] =~ /^ {0,3}\|/;
        my $newline = $lines[$i] =~ /\r\n\z/ ? "\r\n" : "\n";
        my @next = $edit->($newline, [@positions{@required}], scalar(@columns), @lines[$start .. $end - 1]);
        $lines[$i + 1] .= $newline if @next && $lines[$i + 1] !~ /\n\z/;
        splice @lines, $start, $end - $start, @next;
        return join('', @lines);
    }
    return undef;
}
my $charter_extra = '';
my @charter_seed;
for my $name (qw(team-charter team-lead)) {
    my $template = read_file("$Bin/../templates/charter/$name.md");
    my $managed = engine_template($name);
    $template =~ s/\r\n/\n/g;
    $template =~ s/\Q$managed\E//;
    $template =~ s/\s+\z/\n/;
    $template =~ s/\{\{PROJECT\}\}/$label/g;
    my %slots = %{$charter_notes{$name} // {}};
    my $path = safe_path(".codex/$name.md");
    if ($name eq 'team-charter') {
        my $exists = -f $path;
        my $existing = $exists ? markdown_prose(read_file($path)) : '';
        my $selected = length($track) ? $track : $exists ? '' : 'dev';
        my $extra = '';
        my $add_dev = $selected =~ /\A(?:dev|both)\z/ && $existing !~ /^## Команда разработки[ \t]*\r?$/m;
        my $add_pm = $selected =~ /\A(?:pm|both)\z/ && $existing !~ /^## PM-конвейер[ \t]*\r?$/m;
        $extra .= "\n$dev_section" if $add_dev;
        $extra .= "\n$pm_section" if $add_pm && $exists;
        $roster_track = $add_dev ? ($add_pm ? 'both' : 'dev') : ($add_pm ? 'pm' : '') if $exists;
        my $has_pm = $add_pm || $existing =~ /^## PM-конвейер[ \t]*$/m;
        my $has_dev = $add_dev || $existing =~ /^## Команда разработки[ \t]*$/m;
        $default_track = $has_pm ? ($has_dev ? 'both' : 'pm') : 'dev';
        $extra .= "\n## Intake-режим\n\nIntake: " . ($intake || 'plan') . "\n"
            if $exists && length($intake) && $existing !~ /^## Intake-режим[ \t]*$/m;
        if ($exists) { $charter_extra = $extra }
        else {
            $slots{INTAKE_MODE} = 'Intake: ' . ($intake || 'plan');
            $slots{COMMANDS} //= 'Формы проверок и рабочие каталоги закреплены в memory/commands/<репо>.md. Индекс — memory/commands/README.md.';
            $slots{PM_PIPELINE} = $pm_section if $add_pm;
            $slots{BEERPOWERS_VERSION} = "<!-- generated-by: beerpowers-codex v$version · mode: plugin-linked -->" if $current_setup;
            $template .= $extra;
            $template .= "\n" . $managed if $current_setup;
        }
    } elsif ($name eq 'team-lead' && $current_setup && !-f $path) {
        $template .= "\n" . $managed;
    }
    push @charter_seed, [$path, $template, \%slots];
}
my %workspace_defaults = (schemaVersion => 1, beerpowers => $version, projectName => $project_name);
my $workspace_changed = 0;
if (defined($project_input) && ref($saved_workspace) eq 'HASH' && !defined($saved_label)) {
    $saved_workspace->{projectName} = $project_name;
    $workspace_changed = 1;
}
if (!$doctor && !$machine_plan && length($ENV{BEERPOWERS_VIEWPORTS_JSON} // '')) {
    my $viewports = parse_json($ENV{BEERPOWERS_VIEWPORTS_JSON});
    my %names;
    die "Expected confirmed viewports with name, width, height and mobile\n"
        unless ref($viewports) eq 'ARRAY' && @$viewports && !grep {
            ref($_) ne 'HASH' || ($_->{name} // '') !~ /\A[A-Za-z0-9_-]+\z/ || $names{$_->{name}}++ ||
            ($_->{width} // '') !~ /\A[1-9][0-9]*\z/ || ($_->{height} // '') !~ /\A[1-9][0-9]*\z/ ||
            !JSON::PP::is_bool($_->{mobile})
        } @$viewports;
    $_->{width} = 0 + $_->{width}, $_->{height} = 0 + $_->{height} for @$viewports;
    @workspace_defaults{qw(ui viewports)} = (JSON::PP::true, $viewports);
    if (ref($saved_workspace) eq 'HASH' && !exists $saved_workspace->{viewports}) {
        @{$saved_workspace}{qw(ui viewports)} = @workspace_defaults{qw(ui viewports)};
        $workspace_changed = 1;
    }
}
if (!$doctor && !$machine_plan && length($ENV{BEERPOWERS_PARALLEL_TESTS_JSON} // '')) {
    my $proposed = parse_json($ENV{BEERPOWERS_PARALLEL_TESTS_JSON});
    my %known = map { $_ => 1 } @repos;
    die "Expected parallel tests for known products\n" unless ref($proposed) eq 'HASH' &&
        ref($proposed->{repos}) eq 'HASH' && keys(%{$proposed->{repos}}) &&
        !grep { !$known{$_} } keys %{$proposed->{repos}};
    my $node = $ENV{BEERPOWERS_NODE} || 'node';
    my $script = "$Bin/parallel-tests.mjs";
    if ($^O eq 'cygwin') {
        $node = Cygwin::win_to_posix_path($node) if $node =~ /^[A-Za-z]:/;
        $script = Cygwin::posix_to_win_path($script);
    }
    system {$node} $node, $script, '--check-config';
    die "Invalid parallel tests configuration\n" if $? != 0;
    $workspace_defaults{tests} = $proposed;
    if (ref($saved_workspace) eq 'HASH') {
        my $previous = $saved_workspace->{tests} // {};
        die "Invalid saved tests configuration\n" unless ref($previous) eq 'HASH' &&
            (!exists($previous->{repos}) || ref($previous->{repos}) eq 'HASH');
        my %merged = %$previous;
        $merged{slots} //= $proposed->{slots} if exists $proposed->{slots};
        $merged{repos} = {%{$previous->{repos} // {}}};
        for my $name (sort keys %{$proposed->{repos}}) {
            die "Conflicting parallel tests settings for $name\n" if exists($merged{repos}{$name}) &&
                $json->encode($merged{repos}{$name}) ne $json->encode($proposed->{repos}{$name});
            $merged{repos}{$name} = $proposed->{repos}{$name};
        }
        if ($json->encode($previous) ne $json->encode(\%merged)) {
            $saved_workspace->{tests} = \%merged;
            $workspace_changed = 1;
        }
    }
}
if ($workspace_changed) {
    $saved_workspace->{schemaVersion} //= 1;
    replace_setup_file($workspace_file, $json->encode($saved_workspace));
}
seed($workspace_file, $json->encode(\%workspace_defaults), sub {
    my $config = parse_json($_[0]);
    return 0 unless ref($config) eq 'HASH';
    my $saved = $config->{beerpowers} // '';
    return 0 unless $saved =~ /\A(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){2}\z/;
    # The only schema-less release with this layout was 0.2.0.
    my $compatible = exists($config->{schemaVersion})
        ? $json->encode($config->{schemaVersion}) =~ /\A1\s*\z/
        : $saved eq '0.2.0' && keys(%$config) == 1;
    unless ($compatible) {
        print "Unsupported workspace format (created by $saved, package $version); expected schema 1 or the original 0.2.0 file.\n";
        return 0;
    }
    print "Compatible workspace: created by $saved, package $version (schema 1).\n" if $saved ne $version;
    return 1;
});
my $profile_add = !$doctor && -f $git_file && grep { !exists $existing_profiles{$_} } @repos;
seed($git_file, $json->encode($git_settings), sub {1});
push @changes, [$git_file, read_file($git_file), $json->encode($git_settings), 'replace'] if $profile_add;
my @checks = map { "memory/commands/$_.md" } @repos;
my (%memory_notes, %memory_slots);
my %command_index = map { ("$_.md", ['Штатные проверки репозитория ' . $_, 'Роли этого продукта и тимлид']) } @repos;
my (%scope_notes, %requested_index);
$memory_slots{INVARIANTS_DETAILED} = 'При setup не выявлены.';
if (!$doctor && !$machine_plan && length($ENV{BEERPOWERS_MEMORY_JSON} // '')) {
    my $input = parse_json($ENV{BEERPOWERS_MEMORY_JSON});
    my %slot_names = (projectMap => 'PROJECT_MAP', domainInvariants => 'INVARIANTS_DETAILED',
        breakpoints => 'BREAKPOINTS', neverCode => 'NEVER_CODE', confirmExtra => 'CONFIRM_EXTRA',
        ownersExtra => 'OWNERS_EXTRA');
    die "Expected supported memory sections in BEERPOWERS_MEMORY_JSON\n"
        unless ref($input) eq 'HASH' && !grep { !exists $slot_names{$_} && $_ ne 'commands' &&
            $_ ne 'safetyRules' && $_ ne 'commandIndex' } keys %$input;
    if (exists $input->{commandIndex}) {
        my $rows = $input->{commandIndex};
        die "Expected command index rows\n" unless ref($rows) eq 'ARRAY';
        my %seen;
        for my $row (@$rows) {
            die "Invalid command index row\n" unless ref($row) eq 'HASH' &&
                !grep { !defined($row->{$_}) || ref($row->{$_}) || $row->{$_} !~ /\S/ ||
                    $row->{$_} =~ /[\r\n\x00|]/ } qw(file contents readers);
            my $file = $row->{file};
            die "Invalid or duplicate command index file\n" unless $file =~ /\A[A-Za-z0-9_][A-Za-z0-9_.-]*\.md\z/ &&
                lc($file) ne 'readme.md' && !$seen{lc($file)}++ &&
                !grep { lc($_) eq lc($file) && $_ ne $file } keys %command_index;
            my $destination = safe_path("memory/commands/$file");
            if (!exists($command_index{$file}) && !-f $destination) {
                my $body = $row->{markdown};
                die "Expected Markdown for new command note $file\n" unless defined($body) && !ref($body) &&
                    $body =~ /\S/ && $body !~ /\x00|\{\{|<!--\s*\/?beerpowers:engine/;
                $scope_notes{$destination} = encode('UTF-8', $body);
            }
            $command_index{$file} = [map { encode('UTF-8', $row->{$_}) } qw(contents readers)];
            $requested_index{$file} = 1;
        }
    }
    for my $key (sort keys %slot_names) {
        next unless exists $input->{$key};
        my $markdown = $input->{$key};
        die "Expected nonempty Markdown for memory slot $key\n" unless defined($markdown) && !ref($markdown) &&
            $markdown =~ /\S/ && $markdown !~ /\x00|\{\{|<!--\s*\/?beerpowers:engine/;
        $markdown =~ s/\s+\z//;
        my $heading = $key eq 'projectMap' ? "## Карта по итогам разведки\n\n" : '';
        $memory_slots{$slot_names{$key}} = $heading . encode('UTF-8', $markdown);
    }
    my $commands = exists $input->{commands} ? $input->{commands} : {};
    my %known_repos = map { $_ => 1 } @repos;
    die "Expected command notes keyed by known product in BEERPOWERS_MEMORY_JSON\n"
        unless ref($commands) eq 'HASH' && !grep { !$known_repos{$_} } keys %$commands;
    my @notes = (
        (exists $input->{safetyRules} ? ['project/safety-rules.md', 'Проектные запреты', $input->{safetyRules}] : ()),
        map { ["commands/$_.md", 'Памятка команд', $commands->{$_}] } sort keys %$commands,
    );
    for my $note (@notes) {
        my ($path, $heading, $markdown) = @$note;
        die "Expected nonempty Markdown for memory/$path\n"
            unless defined($markdown) && !ref($markdown) && $markdown =~ /\S/ && $markdown !~ /\x00/;
        $markdown =~ s/\s+\z//;
        $memory_notes{$path} = "\n## $heading\n\n" . encode('UTF-8', $markdown) . "\n";
    }
}
my %command_rows = map { $_ => "| [$_]($_) | " . join(' | ', @{$command_index{$_}}) . ' |' } keys %command_index;
$memory_slots{COMMANDS_INDEX} = join("\n", @command_rows{sort keys %command_rows});
unless ($doctor) {
    seed($_, $scope_notes{$_}) for sort keys %scope_notes;
}
my $index = "# Память команды\n";
my $render_memory = sub {
    my $body = read_file($_[0]);
    $body =~ s/\{\{PROJECT\}\}/$label/g;
    return render_sections($body, \%memory_slots);
};
# An existing project owns its memory unless its index contains our managed block.
my $memory_index = safe_path('memory/MEMORY.md');
my $shared_memory = 0;
if (-f $memory_index) {
    $shared_memory = markdown_prose(read_file($memory_index)) !~ /^<!-- beerpowers:engine codex-memory -->$/m;
} elsif (-d 'memory') {
    opendir my $memory_dir, 'memory' or die "memory: $!\n";
    $shared_memory = scalar grep { $_ ne '.' && $_ ne '..' } readdir $memory_dir;
    closedir $memory_dir;
}
if (!$shared_memory && !$doctor) {
    my $base = "$Bin/../templates/memory";
    my @templates;
    File::Find::find({no_chdir => 1, wanted => sub {
        push @templates, $File::Find::name if -f $File::Find::name;
    }}, $base);
    for my $file (sort @templates) {
        my $relative = substr($file, length($base) + 1);
        my $destination = "memory/$relative";
        next if grep { lc($_) eq lc($destination) } @checks;
        my $body = $render_memory->($file);
        if ($relative eq 'MEMORY.md') {
            $index = $body;
            next;
        }
        seed($destination, $body . ($memory_notes{$relative} // ''), sub {1});
    }
} elsif (!$shared_memory && $current_setup) {
    $index .= "\n" . engine_template('memory-index');
}
if (!$doctor && keys %requested_index) {
    my $path = safe_path('memory/commands/README.md');
    if (-f $path) {
        my $before = read_file($path);
        my $after = edit_setup_table($before, $command_index_header, undef, sub {
            my ($newline, $positions, $count, @rows) = @_;
            my @file_cells = map { (table_cells($_))[$positions->[0]] // '' } @rows;
            my @missing = grep {
                my $file = $_;
                !grep { /(?<!!)\[[^\]\n]*\]\((?:\.\/)?\Q$file\E(?:[#\s)]|\z)/ } @file_cells
            } sort keys %requested_index;
            $rows[-1] .= $newline if @missing && @rows && $rows[-1] !~ /\n\z/;
            return (@rows, map {
                my @values = map { trim_cell($_) } table_cells($command_rows{$_});
                fill_table_row([(' ') x $count], $positions, \@values) . $newline
            } @missing);
        });
        if (defined $after) {
            push @changes, [$path, $before, $after, 'replace'] if $after ne $before;
        } else {
            append_lines($path, join("\n", '', $command_index_header, '|---|---|---|',
                @command_rows{sort keys %requested_index}, ''));
        }
    } elsif ($shared_memory) {
        seed($path, $render_memory->("$Bin/../templates/memory/commands/README.md"));
    }
}
seed('memory/MEMORY.md', $index . "\n" . join('', map { "- [Проверки $_](commands/$_.md)\n" } @repos));
if ($shared_memory && !$doctor) {
    my %sections = (
        'project/domain-invariants.md' => 1,
        'project/project-map.md' => exists $memory_slots{PROJECT_MAP},
        'project/safety-rules.md' => exists($memory_slots{NEVER_CODE}) || exists($memory_slots{CONFIRM_EXTRA}) ||
            exists($memory_notes{'project/safety-rules.md'}),
        'tests/frontend.md' => exists $memory_slots{BREAKPOINTS},
    );
    for my $relative (sort grep { $sections{$_} } keys %sections) {
        my $body = $render_memory->("$Bin/../templates/memory/$relative");
        seed("memory/$relative", $body . ($memory_notes{$relative} // ''), sub {1});
    }
}
for my $name ($read_saved_checks ? () : @repos) {
    my $path = "memory/commands/$name.md";
    next if -f $path;
    my $product = "projects/$name";
    my ($command, $source) = @{$test_inputs{$name} // {}}{qw(command source)};
    my $test_doc = "# Команды — $name\n\n## Гейты\n\nПолный прогон тестов. При setup команда записана по источнику и не прогонялась.\n\nКаталог запуска: \x60$product/\x60\nИсточник: \x60$source\x60\n\n```text\n$command\n```\n";
    $test_doc .= $memory_notes{"commands/$name.md"} // '';
    seed($path, $test_doc);
}

sub append_lines {
    my ($path, $addition) = @_;
    safe_path($path);
    die "$path: expected regular file\n" if -e $path && !-f $path;
    my $original = -f $path ? read_file($path) : undef;
    if (defined $original && length $original) {
        die "$path: expected UTF-8 text\n" if $original =~ /\x00/;
        $addition = "\n$addition" unless $original =~ /\n\z/;
        $addition =~ s/\n/\r\n/g if $original =~ /\r\n/;
    }
    push @changes, [$path, $original, $addition];
}

sub replace_setup_file {
    my ($path, $content) = @_;
    push @changes, [$path, read_file(safe_path($path)), $content, 'replace'];
}

require "$Bin/role-packet.pl";
my @configured = sort keys %existing_profiles;
my %rosters;
stage_six_setup("$Bin/..", $version, "projects/$repos[0]", $json, \@repos,
    @configured == 1 ? $configured[0] : undef, $roster_track, $default_track, $size, \%test_inputs, $doctor, $machine_plan,
    $mode eq 'plan' && !$machine_plan, $label, \%rosters);
for my $document (@charter_seed) {
    my ($path, $template, $slots) = @$document;
    if ($path eq '.codex/team-charter.md' && !$doctor) {
        my %planned = roster_rows(\%rosters);
        if (!-f $path) {
            $slots->{ROLES_TABLE} //= join("\n", $roster_header, '|---|---|---|', @planned{sort keys %planned});
        } else {
            my $before = read_file($path);
            my $after = edit_setup_table($before, $roster_header, '## Состав', sub {
                my ($newline, $positions, $count, @rows) = @_;
                my %missing = %planned;
                my %core = map { $_ => 1 } @$positions;
                my @updated;
                for my $line (@rows) {
                    my @cells = table_cells($line);
                    my @values = map { trim_cell($cells[$_] // '') } @$positions;
                    my ($role) = $values[0] =~ /\A`?([a-z-]+)`?\z/;
                    if (defined($role)) {
                        delete $missing{$role};
                        my $prior = $values[1] =~ /\A[A-Za-z0-9_.-]+(?:, [A-Za-z0-9_.-]+)*\z/
                            ? roster_row($role, split /, /, $values[1]) : undef;
                        if (defined($prior) && $prior eq fill_table_row([], [0, 1, 2], \@values)) {
                            if (exists($planned{$role}) && $planned{$role} ne $prior) {
                                my @planned_values = map { trim_cell($_) } table_cells($planned{$role});
                                $line = fill_table_row(\@cells, $positions, \@planned_values) . $newline;
                            } elsif (!exists $planned{$role} &&
                                !grep { !$core{$_} && trim_cell($cells[$_] // '') ne '' } 0 .. $#cells) {
                                next;
                            }
                        }
                    }
                    push @updated, $line;
                }
                $updated[-1] .= $newline if %missing && @updated && $updated[-1] !~ /\n\z/;
                return (@updated, map {
                    my @values = map { trim_cell($_) } table_cells($missing{$_});
                    fill_table_row([(' ') x $count], $positions, \@values) . $newline
                } sort keys %missing);
            });
            if (!defined($after) && length($roster_track) &&
                markdown_prose($before) =~ /^## Состав\r?\n(?:(?!^#{1,2} ).)*^\|/ms) {
                push @errors, "$path: roster table needs unique columns Роль, Продукты and Read on spawn";
            }
            if (defined($after) && $after ne $before) {
                if (length $charter_extra) {
                    my $newline = $before =~ /\r\n/ ? "\r\n" : "\n";
                    $after .= $newline unless $after =~ /\n\z/;
                    $after .= $charter_extra =~ s/\n/$newline/gr;
                }
                push @changes, [$path, $before, $after, 'replace'];
            } elsif (length $charter_extra) {
                append_lines($path, $charter_extra);
            }
        }
    }
    seed($path, render_sections($template, $slots));
}

my $agents = safe_path('AGENTS.md');
my $instructions = -f $agents ? markdown_prose(read_file($agents)) : '';
my $begin = '<!-- beerpowers:engine entry -->';
my $end = '<!-- /beerpowers:engine -->';
my $extra = '';
if (index($instructions, $begin) < 0 && !$doctor) {
    my $other_blocks = $instructions;
    $other_blocks =~ s/^<!-- beerpowers:engine [\w-]+(?: if=[\w:.-]+)? -->\r?\n(?:(?!<!-- \/?beerpowers:engine).)*?^<!-- \/beerpowers:engine -->\r?$//msg;
    if ($other_blocks =~ /<!-- \/?beerpowers:engine\b/) { push @errors, "$agents: unbalanced engine markers" }
    else { $extra .= "\n" . engine_template('entry') }
} elsif ($instructions !~ /\Q$begin\E(.*?)\Q$end\E/s ||
    index($1, '(.codex/team-charter.md)') < 0 || index($1, '(.codex/team-lead.md)') < 0) {
    push @errors, "$agents: missing or incomplete charter/lead entry";
}
my $role_begin = '<!-- beerpowers:role-packet -->';
my $role_end = '<!-- /beerpowers:role-packet -->';
my $guide = 'Тимлид читает .codex/role-settings.json и применимые .codex/rules/ перед работой с продуктом. Для ролевых задач BeerPowers явно передаёт инструкции через role-packet. При смене путей подбери правила заново. Запись в память роли ограничена её каталогом .codex/agent-memory/.';
if (index($instructions, $role_begin) < 0 && !$doctor && index($instructions, $role_end) < 0) {
    $extra .= "\n$role_begin\n$guide\n$role_end\n";
} elsif ($instructions !~ /\Q$role_begin\E(?:(?!\Q$role_end\E).)*role-packet(?:(?!\Q$role_end\E).)*\Q$role_end\E/s) {
    push @errors, "$agents: missing or incomplete role-packet entry; run setup";
}
if (@repos > 1 && index($instructions, '<!-- beerpowers:products -->') < 0) {
    my $guide = 'Для каждого выбранного продукта команды берутся из memory/commands/<репо>.md, профиль из .codex/git-settings.json, правила роли из .codex/role-settings/<репо>.json. Выбирай продукт через BEERPOWERS_REPO.';
    if ($doctor) { push @errors, "$agents: missing multi-product entry; run setup" }
    else { $extra .= "\n<!-- beerpowers:products -->\n$guide\n<!-- /beerpowers:products -->\n"; }
}
append_lines($agents, $extra) if length $extra;

my %ignore = ("projects/$repo/probe" => '/projects/', "worktrees/BP-1/$repo/probe" => '/worktrees/',
    '.codex/.cache/probe' => '/.codex/.cache/');
for my $file (qw(git-settings.local.json figma-settings.json yandex-tracker-settings.json)) {
    $ignore{".codex/$file"} = "/.codex/$file";
}
for my $dir (qw(figma screenshots tracker/task-attachment)) {
    $ignore{"memory/tasks/fix/test/$dir/probe"} = "/memory/tasks/**/$dir/";
}
die "Personal settings or task media already tracked; review the outer index before setup\n"
    if length git_output('ls-files', '--', qw(.codex/git-settings.local.json .codex/figma-settings.json .codex/yandex-tracker-settings.json .codex/.cache/),
        map { ":(glob)memory/tasks/**/$_/**" } qw(figma screenshots tracker/task-attachment));
open my $probe, '-|', 'git', 'check-ignore', '-v', '--no-index', '--', sort keys %ignore or die "git: $!\n";
my $matches = do { local $/; <$probe> } // '';
close $probe;
die "git check-ignore failed\n" if ($? >> 8) > 1;
for my $match (split /\r?\n/, $matches) {
    my ($pattern, $target) = $match =~ /^\.gitignore:\d+:([^\t]+)\t(.+)$/;
    next unless defined $target && $pattern !~ /^!/;
    # Preserve the original guarantee that the complete projects/worktrees directories are ignored.
    next if $target =~ m{\A(projects|worktrees)/} && $pattern ne "$1/" && $pattern ne "/$1/";
    delete $ignore{$target};
}
my @rules;
for my $rule (sort values %ignore) {
    $doctor ? push(@errors, ".gitignore: missing root rule $rule") : push(@rules, "$rule\n");
}
append_lines('.gitignore', join('', @rules)) if @rules;
die join("\n", @errors) . "\n" if @errors;
if ($packet) {
    die "Choose BEERPOWERS_REPO for role-packet: @repos\n" if @repos > 1 && !length($ENV{BEERPOWERS_REPO} // '');
    role_packet(dirname($Bin), $repo, @ARGV); exit 0;
}
if ($review || $handover || $feature) {
    my $code = $ARGV[0] // '';
    die "Invalid task name\n" unless $code =~ m{\A[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*\z};
    my $file = safe_path("memory/tasks/$code/checkouts.json");
    if (-f $file) {
        my $records = parse_json(read_file($file))->{repos};
        die "Invalid task products in $file\n" unless ref($records) eq 'ARRAY' && @$records;
        if (!length($ENV{BEERPOWERS_REPO} // '')) {
            die "Choose BEERPOWERS_REPO for $code\n" unless @$records == 1;
            $repo = $records->[0]{name};
        }
        die "Unknown product in $file\n" unless grep { $_ eq $repo } @repos;
        my @matching = grep { ($_->{name} // '') eq $repo } @$records;
        die "Expected one $repo checkout in $file\n" unless @matching == 1;
        $product = $matching[0]{checkout} // '';
        die "Unexpected checkout in $file\n" unless $product eq "projects/$repo" || $product eq "worktrees/$code/$repo";
        safe_path($product);
        safe_path("$product/.git");
        my $top = git_output('-C', $product, 'rev-parse', '--show-toplevel'); chomp $top;
        my $list = git_output('-C', "projects/$repo", 'worktree', 'list', '--porcelain', '-z');
        die "Checkout does not belong to task $code in $repo\n"
            unless grep { /(?:\A|\0)worktree \Q$top\E\0/ && /\0branch refs\/heads\/\Q$code\E(?:\0|\z)/ }
                split /\0\0/, $list;
        print "Task product: $repo\nCheckout path: $product\n";
    } elsif (@repos > 1 && !length($ENV{BEERPOWERS_REPO} // '')) {
        die "Choose BEERPOWERS_REPO for $code: @repos\n";
    }
}
if ($task || $handover || $feature) {
    require "$Bin/task-start.pl";
    require "$Bin/handover.pl";
    if ($task) {
        require "$Bin/task-integrations.pl";
        stage_seven_task($product, $mode, @ARGV) || task_start($product, $mode, @ARGV);
    }
    elsif ($handover) { update_handover($product, @ARGV) }
    else { require "$Bin/feature-state.pl"; feature_state($product, @ARGV) }
    exit 0;
}
if ($review) {
    require "$Bin/review-diff.pl";
    review_diff($product, @ARGV);
    exit 0;
}
if ($doctor) {
    for my $hook (qw(setup teardown)) {
        my ($path) = grep { -f safe_path($_) } map { ".codex/bin/worktree-$hook$_" } ('.mjs', '', '.ps1');
        print "Worktree $hook hook: ", ($path // 'not configured'), "\n";
    }
    for my $name (qw(yandex-tracker-settings.json figma-settings.json git-settings.local.json)) {
        my $path = safe_path(".codex/$name");
        print "Personal settings $path: ", (-f $path ? 'present' : 'absent'), " (workspace path only; access untested)\n";
    }
    print "Project OK: $_\n" for @checks;
    exit 0;
}
if ($machine_plan) {
    my @plan = map {
        my ($path, $before, $content, $replace) = @$_;
        +{ path => $path, action => $replace ? 'UPDATE' : defined($before) ? 'APPEND' : 'CREATE',
           content => encode_base64($content, '') };
    } @changes;
    print STDOUT $json->encode({format => 1, changes => \@plan});
    exit 0;
}
unless (@changes) { print "No changes.\n"; exit 0 }

for my $change (@changes) {
    my ($path, $before, $addition, $action) = @$change;
    print ($action ? "UPDATE $path\n" : defined($before) ? "APPEND $path\n" : "CREATE $path\n");
    if ($mode eq 'plan') {
        $addition =~ s/^/+ /mg;
        print $addition;
        next;
    }
    make_path(dirname($path));
    if ($action) {
        open my $lock, '<', '.git/config' or die ".git/config: $!\n";
        flock $lock, LOCK_EX or die "Workspace busy\n";
        die "$path changed during setup; run plan again\n" unless read_file(safe_path($path)) eq $before;
        my ($fh, $tmp) = tempfile('beerpowers-settings-XXXXX', DIR => '.git', UNLINK => 1);
        binmode $fh; print {$fh} $addition or die "$tmp: $!\n"; close $fh or die "$tmp: $!\n";
        chmod((stat($path))[2] & 0777, $tmp) or die "$tmp: $!\n";
        rename($tmp, $path) or die "$path: $!\n";
        next;
    }
    my $flags = defined($before) ? O_RDWR : O_WRONLY | O_CREAT | O_EXCL;
    sysopen my $file, $path, $flags or die "$path: $!\n";
    binmode $file;
    flock $file, LOCK_EX or die "$path: $!\n";
    if (defined $before) {
        local $/;
        my $current = <$file> // '';
        die "$path changed during setup; run plan again\n" unless $current eq $before;
        seek $file, 0, SEEK_END or die "$path: $!\n";
    }
    print {$file} $addition or die "$path: $!\n";
    close $file or die "$path: $!\n";
}
