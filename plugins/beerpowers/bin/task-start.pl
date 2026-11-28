# Разбирает и возобновляет задачу, согласует базу и фиксирует подготовленные артефакты.
use strict;
use warnings;
use Fcntl qw(:flock);
use Encode qw(encode);
use Digest::SHA qw(sha256_hex);
use File::Temp qw(tempfile);

# All paths and Git arguments are passed literally. Requests carry UTF-8 JSON in
# the environment so PowerShell 5.1 cannot reinterpret quotes in the brief.
sub task_text {
    my ($data, $key) = @_;
    my $value = $data->{$key};
    die "Missing task field: $key\n" unless defined $value && !ref($value) && $value =~ /\S/ && $value !~ /\0/;
    return encode('UTF-8', $value);
}

sub task_quote {
    my $text = shift;
    $text =~ s/\r\n/\n/g;
    $text =~ s/^/> /mg;
    return $text;
}

sub is_feature_brief {
    return $_[0] =~ /^Класс: feature\./m ? 1 : 0;
}

sub feature_base {
    my $brief = markdown_prose($_[0]);
    my @bases = $brief =~ /^Base-SHA: ([0-9a-f]{40}|[0-9a-f]{64})\r?$/mg;
    if (!@bases && defined $ENV{BEERPOWERS_REPO}) {
        my $repo = $ENV{BEERPOWERS_REPO};
        @bases = $brief =~ /^Base-SHA \Q$repo\E: ([0-9a-f]{40}|[0-9a-f]{64})\r?$/mg;
    }
    die "Feature preflight needs exactly one verified Base-SHA\n" unless @bases == 1;
    return $bases[0];
}

sub task_path {
    my $path = safe_path(shift);
    my $parent = '.';
    for my $part (split '/', $path) {
        last unless -d $parent;
        opendir my $entries, $parent or die "$parent: $!\n";
        die "Case collision: $parent/$part\n"
            if grep { lc($_) eq lc($part) && $_ ne $part } readdir $entries;
        closedir $entries;
        $parent .= "/$part";
    }
    return $path;
}

sub ref_collision {
    my ($a, $b) = map { lc $_ } @_;
    return $a eq $b || index("$a/", "$b/") == 0 || index("$b/", "$a/") == 0;
}

sub working_status {
    return git_output('-C', $_[0], '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1',
        '--ignore-submodules=none', '--untracked-files=all', '-z');
}

sub check_checkout {
    my ($root) = @_;
    my $dir = "$root/.git";
    if (-f $dir && $root =~ m{\Aworktrees/(.+)/([^/]+)\z}) {
        my ($code, $repo) = ($1, $2);
        my $common = git_output('-C', $root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
        die "Unregistered product worktree: $root\n" unless $common eq
            git_output('-C', safe_path("projects/$repo"), 'rev-parse', '--path-format=absolute', '--git-common-dir')
            && git_output('-C', $root, 'branch', '--show-current') eq "$code\n";
        $dir = git_output('-C', $root, 'rev-parse', '--absolute-git-dir');
        chomp $dir;
    }
    die "Linked worktree or nonstandard Git directory: $root\n" unless -d $dir && !-l "$root/.git";
    for my $marker (qw(index.lock HEAD.lock MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_START rebase-apply rebase-merge sequencer)) {
        die "Git operation in progress: $dir/$marker\n" if -e "$dir/$marker";
    }
}

# Publish complete bytes. Temp files live in the outer Git directory, including
# after a process kill. Never expose a partially written Markdown or journal.
sub publish_task_file {
    my ($path, $body) = @_;
    my ($fh, $temp) = tempfile('beerpowers-write-XXXXXX', DIR => '.git', UNLINK => 1);
    binmode $fh;
    print {$fh} $body or die "$temp: $!\n";
    close $fh or die "$temp: $!\n";
    my $mask = umask;
    chmod((-e $path ? (stat $path)[2] & 0777 : 0666 & ~$mask), $temp) or die "$temp: $!\n";
    rename $temp, $path or die "Publish $path: $!\n";
}

sub validate_task_name {
    my ($code) = @_;
    die "Expected a descriptive task name\n"
        unless defined $code
        && $code =~ m{\A[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*\z}
        && length($code) <= 200;
    for my $part (split '/', $code) {
        die "Unsafe task name: $code\n" if $part =~ /(?:\.\.|\.$|\.lock$)/i
            || $part =~ /\A(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i
            || $part =~ /\A(?:HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REBASE_HEAD|REVERT_HEAD|AUTO_MERGE)\z/i;
    }
    git_output('check-ref-format', '--branch', $code);
}

sub task_start {
    my ($product, $mode, $code, @flags) = @_;
    my $preview = $mode eq 'task-start' && @flags == 1 && $flags[0] eq '--preview';
    my $plan = $mode eq 'task-plan';
    die "Expected one task name and optional --preview\n" if @flags && !$preview;
    validate_task_name($code);
    my $lock;
    unless ($preview) {
        check_checkout('.');
        check_checkout($product);
    }
    unless ($preview || $plan) {
        # Serialize task starts without creating a lock file in either checkout.
        open $lock, '<', '.git/config' or die ".git/config: $!\n";
        flock($lock, LOCK_EX | LOCK_NB) or die "Another task-start is active\n";
    }
    my $dir = task_path("memory/tasks/$code");
    my $file = task_path("$dir/preflight.md");
    die "Unsupported tracker or non-profile base in $dir\n" if -e "$dir/tracker" || -e "$dir/git-flow.md";
    for (my $p = dirname($dir); $p ne 'memory/tasks'; $p = dirname($p)) {
        die "Nested task in $p\n" if -e "$p/preflight.md" || -e "$p/git-flow.md" || -d "$p/tracker";
    }
    die "Expected a regular preflight: $file\n" if -e $file && !-f $file;
    my $journal = '.git/beerpowers-task-start.json';
    safe_path($journal) unless $preview;
    my $pending = !$preview && -e $journal ? parse_json(read_file($journal)) : undef;
    die "Interrupted task-start: inspect $journal and resume its task first\n"
        if defined $pending && (ref($pending) ne 'HASH' || ($pending->{code} // '') ne $code);
    die "Task directory already exists without preflight: $dir\n" if !$preview && -d $dir && !-f $file && !$pending;

    my $args = parse_json($ENV{BEERPOWERS_TASK_JSON} // '{}');
    die "Expected a task object\n" unless ref($args) eq 'HASH';
    # An existing task on its own checkout is a local, read-only entry.
    # Never stage or attribute unfinished files merely because the branch matches.
    my @git = ('-C', $product);
    my $current = $preview ? '' : git_output(@git, 'branch', '--show-current');
    chomp $current;
    my $saved_checkout = !$preview && !$pending && $current eq $code && -f $file
        && length git_output('ls-tree', 'HEAD', '--', $file);
    if ($saved_checkout && !keys %$args) {
        resume_evidence($product, $dir);
        return;
    }
    my $class = task_text($args, 'class');
    die "Expected class lean, trivial or feature\n" unless $class =~ /\A(?:lean|trivial|feature)\z/;
    my $resume = -f $file || $pending;
    die "Existing preflight for $code; review the class\n" if !$preview && $resume && $class eq 'trivial';
    my $reason = task_text($args, 'reason');
    my $scope = task_text($args, 'scope');
    my $acceptance = task_text($args, 'acceptance');
    my $forks = task_text($args, 'forks');
    my $stops = task_text($args, 'stops');
    my $statement = task_text($args, 'statement');
    my $before = -f $file ? read_file($file) : undef;
    if (!$preview && defined $before && (($class eq 'feature') != is_feature_brief($before))) {
        die "Class differs from saved preflight; reconcile and record reclassification first\n";
    }
    my $intake = exists $args->{intake} ? task_text($args, 'intake') : '';
    die "Expected intake plan, stages, autonomous or design-only\n"
        unless $intake =~ /\A(?:plan|stages|autonomous|design-only)?\z/;
    my $body = $before // "# $code\n\n## Исходная постановка\n\n" . task_quote($statement)
        . "\n\nКласс: $class. $reason\n\nГраницы: $scope\n\nПриёмка: $acceptance\n\nРазвилки: $forks\n\nСтоп-условия: $stops\n";
    if (length $intake || !defined $before) {
        $intake ||= task_intake('');
        my $nl = $body =~ /\r\n/ ? "\r\n" : "\n";
        if ($body !~ s/^(Intake: )(?:plan|stages|autonomous|design-only)(?=\r?$)/${1}$intake/m) {
            $body .= $nl unless $body =~ /\n\z/;
            $body .= $nl . "Intake: $intake" . $nl;
        }
    }
    my $notes = $args->{clarifications} // [];
    die "Expected clarifications array\n" unless ref($notes) eq 'ARRAY';
    for my $note (@$notes) {
        die "Expected a dated clarification\n" unless ref($note) eq 'HASH';
        my $date = task_text($note, 'date');
        die "Expected ISO date\n" unless $date =~ /\A\d{4}-\d{2}-\d{2}\z/;
        my $block = "### $date — уточнение пользователя\n\n" . task_quote(task_text($note, 'quote'))
            . "\n\nСледствие для объёма: " . task_text($note, 'effect') . "\n";
        $block =~ s/\r\n/\n/g;
        my $normalized = $body =~ s/\r\n/\n/gr;
        next if index($normalized, $block) >= 0;
        $block =~ s/\n/\r\n/g if $body =~ /\r\n/;
        $body .= ($body =~ /\r\n/ ? "\r\n" : "\n") . $block;
    }
    print "Task: $code\nClass: $class ($reason)\nScope: $scope\nAcceptance: $acceptance\nForks: $forks\nStop conditions: $stops\n";
    if ($preview) { print "Preview only.\n"; return }
    if ($saved_checkout && $before eq $body) {
        resume_evidence($product, $dir);
        return;
    }
    my $outer_branch = git_output('symbolic-ref', '--quiet', 'HEAD');
    my $outer_head = git_output('rev-parse', '--verify', 'HEAD');
    if ($pending) {
        die "Outer branch changed during task-start\n" unless $outer_branch eq $pending->{branch};
        my $digest = defined $before ? sha256_hex($before) : '';
        # A successful commit followed by interruption is already complete. A
        # different manual edit or branch advance requires human reconciliation.
        my $committed = $outer_head ne $pending->{head} && $digest eq $pending->{after}
            && !length(working_status('.'));
        die "Preflight changed during interrupted task-start: $file\n"
            unless $committed || ($outer_head eq $pending->{head}
                && ($digest eq $pending->{before} || $digest eq $pending->{after}));
    }
    my $outer_status = working_status('.');
    for (split /\0/, $outer_status) {
        die "Busy outer workspace: $_\n" unless $pending && /\A(?:\?\?| A|A | M|M ) \Q$file\E\z/;
    }
    die "Untracked preflight: $file; inspect it before resuming\n"
        if defined $before && !$pending && !length git_output('ls-files', '--', $file);
    if (length working_status($product)) {
        return run_integrated_task($mode, $code) if !$pending && $current ne $code;
        die "Busy product: $product has uncommitted changes\n";
    }
    my $remote = git_output(@git, 'ls-remote', '--symref', 'origin', 'HEAD', 'refs/heads/*');
    my ($base) = $remote =~ /^ref: refs\/heads\/(.+)\tHEAD$/m;
    my ($sha) = $remote =~ /^([a-f0-9]{40,64})\tHEAD$/m;
    die "origin HEAD must name an advertised branch\n" unless defined $base && defined $sha
        && $remote =~ /^\Q$sha\E\trefs\/heads\/\Q$base\E$/m;
    if ($class eq 'feature') {
        my $saved_base = defined($before) ? feature_base($before) : $pending ? $pending->{base} : undef;
        if (defined $saved_base) {
            die "Invalid saved feature base\n" unless $saved_base =~ /\A(?:[a-f0-9]{40}|[a-f0-9]{64})\z/;
            $sha = $saved_base;
        }
    }
    $body .= "\nBase-SHA: $sha\n" if $class ne 'trivial' && !defined $before
        && (!$pending || sha256_hex($body) ne $pending->{after});
    die "Resume with the original brief and clarifications: $file\n"
        if $pending && sha256_hex($body) ne $pending->{after};
    die "Task conflicts with default branch $base\n" if ref_collision($code, $base);
    my @local = split /\n/, git_output(@git, 'for-each-ref', '--format=%(refname:strip=2)', 'refs/heads/');
    my $exists = grep { $_ eq $code } @local;
    if (!$exists && defined $before && (grep { -e task_path("$dir/$_") } qw(handover.md test-cases.md review-report.md feature-state.json design-brief.md))) {
        die "Missing task branch with saved execution evidence; reconcile its original revision before checkout\n";
    }
    my @remote = $remote =~ /^[a-f0-9]+\trefs\/heads\/(.+)$/mg;
    for my $ref (@local, @remote) {
        next unless ref_collision($ref, $code);
        next if $ref eq $code && $exists && ($resume || ($class eq 'trivial' && $current eq $code));
        die "Task branch conflicts with existing ref: $ref\n";
    }
    unless ($current eq $base || $current eq $code) {
        return run_integrated_task($mode, $code) unless $pending;
        die "Busy product branch: $current (default $base)\n";
    }
    my $trees = git_output(@git, 'worktree', 'list', '--porcelain');
    die "Task branch checked out in another worktree: $code\n"
        if $current ne $code && $trees =~ /^branch refs\/heads\/\Q$code\E$/m;
    if ($class ne 'trivial' && !defined $before) {
        system('git', 'check-ignore', '-q', '--', $file);
        die "Ignored or inaccessible task path: $file\n" unless $? == 256;
    }
    print "Base: origin/$base $sha (main-default)\nBranch: $code ", ($exists ? '(exists)' : '(new)'), "\n";
    return if $plan;

    if (!$exists && system('git', @git, 'rev-parse', '--verify', '--quiet', "$sha^{commit}") != 0) {
        git_output(@git, 'fetch', '--no-tags', 'origin', "refs/heads/$base");
        die "Default branch moved; inspect a fresh preview\n" unless git_output(@git, 'rev-parse', 'FETCH_HEAD') eq "$sha\n";
    }
    git_output(@git, 'read-tree', '--dry-run', '-m', '-u', 'HEAD', $sha) unless $exists;
    if ($class ne 'trivial' && (!defined $before || $body ne $before || $outer_status ne '')) {
        git_output('var', 'GIT_AUTHOR_IDENT');
        git_output('var', 'GIT_COMMITTER_IDENT');
        unless ($pending) {
            my $entry = {code => $code, head => $outer_head, branch => $outer_branch,
                before => defined $before ? sha256_hex($before) : '', after => sha256_hex($body)};
            $entry->{base} = $sha if $class eq 'feature';
            publish_task_file($journal, JSON::PP->new->encode($entry));
        }
        make_path($dir);
        task_path($file);
        die "Preflight changed while preparing: $file\n"
            unless defined $before ? -f $file && read_file($file) eq $before : !-e $file;
        publish_task_file($file, $body) unless defined $before && $body eq $before;
        git_output('add', '--', $file);
        git_output('commit', '--only', '-m', "docs($code): зафиксируй постановку задачи", '-m', '© Codex', '--', $file);
        print "Artifact commit: ", git_output('rev-parse', 'HEAD');
    }
    unlink($journal) or die "$journal: $!\n" if -e $journal;
    unless ($exists) {
        die "Product changed during task-start\n" if length working_status($product)
            || git_output(@git, 'symbolic-ref', '--short', 'HEAD') ne "$current\n";
        git_output(@git, 'checkout', '--no-overwrite-ignore', '--no-track', '-b', $code, $sha);
    }
    print "Artifact: ", ($class ne 'trivial' ? $file : '(none)'), "\nCheckout: ",
        git_output(@git, 'symbolic-ref', '--short', 'HEAD');
    print "Preparation only.\n";
}

1;
