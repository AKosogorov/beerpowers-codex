# Сохраняет и читает точку остановки задачи с привязкой к ветке и ревизии.
use strict;
use warnings;
use Fcntl qw(:flock);
use Digest::SHA qw(sha256_hex);
use File::Path qw(make_path);

sub handover_bytes {
    my ($path) = @_;
    task_path($path);
    die "Expected a regular handover: $path\n" if -e $path && !-f $path;
    return -f $path ? read_file($path) : undef;
}

sub task_intake {
    my ($brief) = @_;
    my ($override) = markdown_prose($brief) =~ /^Intake: (plan|stages|autonomous|design-only)$/m;
    return $override if defined $override;
    my $charter = safe_path('.codex/team-charter.md');
    my ($default) = -f $charter ? markdown_prose(read_file($charter)) =~ /^Intake: (plan|stages|autonomous)$/m : ();
    return $default // 'plan';
}

sub resume_evidence {
    my ($product, $task) = @_;
    my ($dir) = product_evidence($task, $product);
    my $handover = handover_bytes("$dir/handover.md");
    my $brief = read_file(task_path("$task/preflight.md"));
    my $feature = is_feature_brief($brief) || -e task_path("$dir/feature-state.json");
    print "Resume existing ", ($feature ? 'feature' : 'lean'), " task (read only).\nCheckout: ",
        git_output('-C', $product, 'symbolic-ref', '--short', 'HEAD'),
        "Source: ", git_output('-C', $product, 'rev-parse', 'HEAD'),
        "Handover digest: ", (defined $handover ? sha256_hex($handover) : 'missing'), "\n";
    print "Intake: ", task_intake($brief), "\n";
    for my $repo ('.', $product) {
        my $status = git_output('-C', $repo, 'status', '--porcelain=v1', '--ignore-submodules=none', '--untracked-files=all');
        print "Status ($repo):\n", ($status || "(clean)\n");
    }
    print "Evidence: $task/preflight.md\n";
    for my $name (qw(handover.md test-cases.md review-report.md), $feature ?
            qw(feature-state.json design-brief.md early-review.md bug-log.md opponent-report.md) : ()) {
        my $path = task_path("$dir/$name");
        print "Evidence: $path\n" if -f $path;
    }
    print "Reconcile the first unmet gate using commands/", ($feature ? 'feature' : 'team-lazy'), ".md.\n";
}

# Byte offsets of the actual section, excluding heading examples inside fences.
sub pause_section {
    my ($body) = @_;
    my ($start, $end, $fence);
    while ($body =~ /([^\n]*(?:\n|\z))/g) {
        my ($line, $at) = ($1, $-[1]);
        last unless length $line;
        if ($at == 0 && $line =~ s/^\xef\xbb\xbf//) { $at += 3 }
        $line =~ s/[\r\n]+\z//;
        if (defined $fence) {
            my $mark = substr($fence, 0, 1);
            undef $fence if $line =~ /^ {0,3}\Q$fence\E\Q$mark\E*[ \t]*$/;
            next;
        }
        if ($line =~ /^ {0,3}(`{3,}|~{3,})/) { $fence = $1; next }
        next unless $line =~ /^ {0,3}#{1,2}(?:[ \t]|$)/;
        $end //= $at if defined $start;
        if ($line =~ /^ {0,3}##[ \t]+Пауза(?:[ \t]+#+)?[ \t]*$/) {
            die "Multiple pause sections; reconcile handover.md\n" if defined $start;
            $start = $at;
        }
    }
    return ($start, $end // length $body);
}

# Role reports are project-owned prose (including 0.4.0). The lead reads the
# latest actual run and verdict; Git independently verifies their revision.
sub check_local_review {
    my ($product, $base, $head, $brief, $report, $requires_opponent) = @_;
    my @actors = markdown_prose($report) =~ /^(Review by: (?:team-lead|reviewer) [0-9a-f]+)$/mg;
    return 'reviewer' unless @actors && $actors[-1] =~ /^Review by: team-lead /;
    die "Independent opponent requires a separate reviewer\n" if $requires_opponent;
    my @files = grep { length } split /\0/, git_output('-C', $product, 'diff', '--no-renames', '--name-only', '-z', $base, $head, '--');
    die "Local economy review requires a scoped decision and one changed file at HEAD\n"
        unless @files == 1 && $actors[-1] eq "Review by: team-lead $head" &&
            markdown_prose($brief) =~ /^Economy local review: \Q$head\E — \S/m;
    return 'team-lead';
}

sub check_completion {
    my ($product, $dir, $head, $data, $brief) = @_;
    my $base = task_text($data, 'base');
    die "Missing passing full run or final approval at HEAD\n"
        unless task_text($data, 'tested') eq $head && task_text($data, 'reviewed') eq $head
        && task_text($data, 'exit') eq '0' && task_text($data, 'verdict') eq 'APPROVED';
    die "Invalid review range\n" unless $base =~ /\A(?:[0-9a-f]{40}|[0-9a-f]{64})\z/
        && system('git', '-C', $product, 'merge-base', '--is-ancestor', $base, $head) == 0
        && length git_output('-C', $product, 'diff', '--name-only', $base, $head, '--');
    for my $report (qw(test-cases.md review-report.md)) {
        my $bytes = read_file(task_path("$dir/$report"));
        die "Missing source SHA in $report\n" unless $bytes =~ /(?<![a-f0-9])\Q$head\E(?![a-f0-9])/;
        if ($report eq 'test-cases.md') {
            my @runs = $bytes =~ /^Full run: ([^\r\n]+)[\r]?$/mg;
            die "Latest full run failed or is stale\n" if @runs && $runs[-1] ne "$head exit=0";
        } else {
            check_local_review($product, $base, $head, $brief, $bytes, 0);
            # Accept the pilot's Markdown verdict headings as well as the
            # single-line form. Compare the source when the heading names it.
            my @entries = $bytes =~ /^((?:\*\*)?(?:NOT APPROVED|APPROVED)\b[^\r\n]*)/mg;
            if (@entries) {
                my $last = $entries[-1];
                die "Latest review did not approve\n" if $last =~ /^(?:\*\*)?NOT APPROVED\b/;
                my ($revision) = $last =~ /^(?:\*\*)?APPROVED(?:\*\*)?\s+(?:(?:для source SHA|at)\s+)?`?([0-9a-f]{40,64})\b/;
                die "Latest review is stale\n" if defined $revision && $revision ne $head;
            }
        }
    }
}

sub update_handover {
    my ($product, $code, $action) = @_;
    die "Expected handover <task> pause|check|clear\n" unless @_ == 3 && $action =~ /\A(?:pause|check|clear)\z/;
    validate_task_name($code);
    check_checkout('.');
    check_checkout($product);
    open my $lock, '<', '.git/config' or die ".git/config: $!\n";
    flock($lock, LOCK_EX | LOCK_NB) or die "Another task update is active\n";
    my $task = task_path("memory/tasks/$code");
    my ($dir, $record) = product_evidence($task, $product);
    my $file = task_path("$task/preflight.md");
    die "Expected a saved preflight\n" unless -f $file && length git_output('ls-tree', 'HEAD', '--', $file);
    my $data = parse_json($ENV{BEERPOWERS_HANDOVER_JSON} // '{}');
    die "Expected handover object\n" unless ref($data) eq 'HASH';
    my $head = task_text($data, 'head');
    die "Wrong product checkout or stale source SHA\n"
        unless git_output('-C', $product, 'symbolic-ref', '--quiet', '--short', 'HEAD') eq "$code\n"
        && git_output('-C', $product, 'rev-parse', 'HEAD') eq "$head\n";
    if ($action ne 'pause') {
        die "Product changed; reconcile before clearing pause\n" if length working_status($product);
        die "Wrong product base in completion\n" if $record && task_text($data, 'base') ne $record->{baseSha};
        if (is_feature_brief(read_file($file)) || -e task_path("$dir/feature-state.json")) {
            my $module = File::Basename::dirname(__FILE__) . '/feature-state.pl';
            require $module;
            feature_check_completed($dir, $head, $data, read_file($file));
        }
        check_completion($product, $dir, $head, $data, read_file($file));
    }
    my $path = "$dir/handover.md";
    my $before = handover_bytes($path);
    my $digest = defined $before ? sha256_hex($before) : 'missing';
    die "Handover changed; reread $path\n" unless task_text($data, 'digest') eq $digest;
    my $body = $before // '';
    my ($start, $end) = pause_section($body);
    if ($action eq 'check') {
        print "Completion verified: $code at $head\n";
        return;
    }
    my $section = '';
    if ($action eq 'pause') {
        my ($date, $phase, $done, $owner, $flight, $blockers, $next) =
            map { task_text($data, $_) } qw(date phase done owner in_flight blockers next);
        die "Expected ISO date and known phase\n" unless $date =~ /\A\d{4}-\d{2}-\d{2}\z/
            && $phase =~ /\A(?:design|impl|test|review)\z/;
        die "Expected single-line pause fields\n" if grep { /[\r\n]/ } ($done, $owner, $flight, $blockers, $next);
        $section = "## Пауза\n\nОбновлено: $date · Фаза: $phase\nВетка: $code · HEAD: $head\n\n"
            . "### Сделано\n\n- $done\n\n### В полёте\n\nВладелец: $owner · $flight\n\n"
            . "### Открытые вопросы / блокеры\n\n- $blockers\n\n### Следующий шаг при продолжении\n\n- $next\n";
        $section .= "\n" if defined $start && $end < length $body;
        $section =~ s/\n/\r\n/g if $body =~ /\r\n/;
    }
    if (defined $start) {
        substr($body, $start, $end - $start, $section);
    } elsif (length $section) {
        my $nl = $body =~ /\r\n/ ? "\r\n" : "\n";
        $body .= $nl if length($body) && $body !~ /\n\z/;
        $body .= $nl if length($body) && $body !~ /\n\r?\n\z/;
        $body .= $section;
    }
    if ($body eq ($before // '')) { print "No changes.\n"; return }
    make_path(task_path($dir)) unless -d $dir;
    publish_task_file($path, $body);
    print "Updated: $path\n";
}

1;
