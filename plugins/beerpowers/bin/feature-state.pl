# Читает и обновляет состояние этапов фичи с проверкой допустимых переходов.
use strict;
use warnings;
use Digest::SHA qw(sha256_hex);
use Encode qw(encode);
use Fcntl qw(:flock);
use File::Path qw(make_path);

# The lead records observed results. Files contain the actual design, review
# and test evidence; this cursor enforces order, revision and retry safety.
my %gate = (
    design  => {'design-ready' => ['implement', 'design-brief.md', 'Design ready']},
    implement => {implemented => ['early-review']},
    fix => {fixed => ['early-review']},
    'early-review' => {
        'early-pass' => ['tests', 'early-review.md', 'EARLY PASS'],
        'early-changes' => ['fix', 'early-review.md', 'EARLY CHANGES']},
    tests => {
        'tests-pass' => ['browser', 'test-cases.md', 'Full run'],
        'tests-fail' => ['fix', 'test-cases.md', 'Full run']},
    browser => {
        'browser-pass' => ['mutations', 'test-cases.md', 'Browser PASS'],
        'browser-fail' => ['fix', 'test-cases.md', 'Browser FAIL']},
    mutations => {
        'mutations-pass' => ['opponent', 'test-cases.md', 'Mutation PASS'],
        'mutations-fail' => ['fix', 'test-cases.md', 'Mutation FAIL']},
    opponent => {
        'opponent-pass' => ['final-review', 'opponent-report.md', 'Opponent PASS'],
        'opponent-changes' => ['fix', 'opponent-report.md', 'Opponent CHANGES']},
    'final-review' => {
        'final-approve' => ['done', 'review-report.md', 'APPROVED'],
        'final-changes' => ['fix', 'review-report.md', 'NOT APPROVED']},
    done => {},
);

sub read_feature_state {
    my ($bytes) = @_;
    my $state = parse_json($bytes);
    die "Unrecognized feature state; inspect feature-state.json\n" unless ref($state) eq 'HASH'
        && ($state->{format} // '') eq 'beerpowers-feature-1'
        && ($state->{head} // '') =~ /\A(?:[a-f0-9]{40}|[a-f0-9]{64})\z/
        && ($state->{base} // '') =~ /\A(?:[a-f0-9]{40}|[a-f0-9]{64})\z/
        && ($state->{brief} // '') =~ /\A[a-f0-9]{64}\z/ && ($state->{mode} // '') =~ /\A[CD]\z/
        && ($state->{ui} // '') =~ /\A(?:yes|no)\z/ && ($state->{requires_opponent} // '') =~ /\A(?:yes|no)\z/
        && exists $gate{$state->{next} // ''} && ref($state->{history}) eq 'ARRAY'
        && ref($state->{reports}) eq 'HASH' && ref($state->{observations}) eq 'HASH';
    return $state;
}

sub feature_report {
    my ($dir, $name) = @_;
    my $path = task_path("$dir/$name");
    die "Expected a regular report: $path\n" unless -f $path;
    return read_file($path);
}

sub verify_feature_reports {
    my ($dir, $state, $editing) = @_;
    for my $name (keys %{$state->{reports}}) {
        die "Unexpected report in state\n" unless $name =~ /\A(?:design-brief|early-review|test-cases|opponent-report|review-report)\.md\z/;
        next if $name eq ($editing // '');
        die "Changed evidence: $name; reconcile and replan\n"
            unless sha256_hex(feature_report($dir, $name)) eq $state->{reports}{$name};
    }
}

# The tester may update the phase table above "## Прогоны". The recorded
# observations below it are append-only, also when the same role retries.
sub report_observations {
    my ($body) = @_;
    $body =~ s/\A.*?^## Прогоны\r?\n//ms;
    return $body;
}

sub check_test_commits {
    my ($product, $state, $head) = @_;
    my %allowed = map { encode('UTF-8', $_) => 1 } @{$state->{test_paths}};
    my $diff = git_output('-C', $product, 'diff', '--no-renames', '--name-only', '-z', $state->{head}, $head, '--');
    for my $path (split /\0/, $diff) {
        die "Changed outside reviewed test paths: $path; repeat early review\n" unless $allowed{$path};
    }
}

sub feature_check_completed {
    my ($dir, $head, $data, $brief) = @_;
    my $state = read_feature_state(feature_report($dir, 'feature-state.json'));
    die "Feature gates incomplete or stale\n" unless $state->{next} eq 'done'
        && $state->{head} eq $head && $state->{base} eq task_text($data, 'base')
        && $state->{brief} eq feature_brief_hash($brief);
    verify_feature_reports($dir, $state);
    verify_feature_widths($state, $brief);
}

sub feature_options {
    my ($state, $data) = @_;
    for my $key (qw(ui requires_opponent)) {
        my $value = task_text($data, $key);
        die "Expected $key=yes or no\n" unless $value eq 'yes' || $value eq 'no';
        $state->{$key} = $value;
    }
}

my $width_line = qr/^UI widths \[[A-Za-z0-9_.,-]+\]: (?:approved|declined|revoked) [^\r\n]+\r?\n/m;

sub feature_brief_hash {
    my ($brief) = @_;
    # Width decisions have their own live layout check and history. They may
    # change between gates without resetting the implementation cursor.
    $brief =~ s/$width_line//g;
    $brief =~ s/^Economy local review: [a-f0-9]{40,64} — [^\r\n]+\r?\n//mg;
    return sha256_hex($brief);
}

sub feature_widths_hash {
    return sha256_hex(join('', $_[0] =~ /($width_line)/g));
}

sub verify_feature_widths {
    my ($state, $brief) = @_;
    die "UI matrix changed; repeat browser phase\n" if $state->{ui} eq 'yes' &&
        ($state->{widths_hash} // sha256_hex('')) ne feature_widths_hash($brief);
}

sub feature_state {
    my ($product, $code, $event) = @_;
    die "Expected feature-state <task> [event]\n" unless @_ == 2 || @_ == 3;
    validate_task_name($code);
    my $task = task_path("memory/tasks/$code");
    my ($dir, $record) = product_evidence($task, $product);
    my $brief = feature_report($task, 'preflight.md');
    die "Expected a prepared feature\n" unless is_feature_brief($brief)
        && length git_output('ls-tree', 'HEAD', '--', "$task/preflight.md");
    die "Wrong product checkout\n" unless git_output('-C', $product, 'symbolic-ref', '--quiet', '--short', 'HEAD') eq "$code\n";
    my $lock;
    if (defined $event) {
        check_checkout('.');
        check_checkout($product);
        open $lock, '<', '.git/config' or die $!;
        flock($lock, LOCK_EX | LOCK_NB) or die "Another task update is active\n";
    }
    my $head = git_output('-C', $product, 'rev-parse', 'HEAD');
    chomp $head;
    my $base = feature_base($brief);
    die "Feature base differs from selected product record\n" if $record && $base ne $record->{baseSha};
    my $path = task_path("$dir/feature-state.json");
    die "Expected regular file: $path\n" if -e $path && !-f $path;
    my $bytes = -f $path ? read_file($path) : undef;
    my $digest = defined $bytes ? sha256_hex($bytes) : 'missing';
    my $state = defined $bytes ? read_feature_state($bytes) : undef;
    my $brief_hash = feature_brief_hash($brief);
    if (!defined $event) {
        print "Evidence directory: $dir\nBase: $base\nSource: $head\nState digest: $digest\n";
        print "Intake: ", task_intake($brief), "\n";
        if ($state) {
            print "Mode: $state->{mode}\nRecorded source: $state->{head}\n";
            print "Preflight changed; reconcile before replan\n" if $brief_hash ne $state->{brief};
            print "Head changed; reconcile before advancing\n" if $head ne $state->{head};
        }
        print "Next: ", ($state ? $state->{next} : 'init'), "\n";
        return;
    }
    my $data = parse_json($ENV{BEERPOWERS_FEATURE_JSON} // '{}');
    die "Expected feature update object\n" unless ref($data) eq 'HASH';
    die "Feature state changed; reread cursor\n" unless task_text($data, 'digest') eq $digest;
    die "Product revision changed; reread checkout\n" unless task_text($data, 'head') eq $head;
    die "Product has uncommitted changes; reconcile before recording gate\n" if length working_status($product);
    die "Feature base is not an ancestor of HEAD\n"
        if system('git', '-C', $product, 'merge-base', '--is-ancestor', $base, $head) != 0;

    my $review_by;
    if ($event eq 'init') {
        die "Already initialized\n" if $state;
        my $mode = task_text($data, 'mode');
        die "Expected mode C or D\n" unless $mode =~ /\A[CD]\z/;
        $state = {format => 'beerpowers-feature-1', next => 'design', mode => $mode, base => $base,
            brief => $brief_hash, history => [], reports => {}, observations => {}};
        feature_options($state, $data);
    } else {
        die "Initialize feature state first\n" unless $state;
        die "Saved base differs from preflight; reconcile manually\n" unless $state->{base} eq $base;
        if ($event eq 'replan') {
            feature_options($state, $data);
            $state->{brief} = $brief_hash;
            $state->{next} = 'design';
            $state->{reports} = {};
            $state->{observations} = {};
            # Decisions under the previous acceptance criteria remain history,
            # even when the product commit itself has not changed.
            for my $name (qw(design-brief.md early-review.md test-cases.md opponent-report.md review-report.md)) {
                next unless -e task_path("$dir/$name");
                my $old = report_observations(feature_report($dir, $name));
                $state->{observations}{$name} = {length => length($old), hash => sha256_hex($old)};
            }
        } else {
            die "Preflight changed; reconcile and replan\n" if $state->{brief} ne $brief_hash;
            if ($event eq 'team-up') {
                die "Source changed during warm-up\n" unless $state->{head} eq $head;
                if ($state->{mode} eq 'D') { print "Already in mode D.\n"; return }
                $state->{mode} = 'D';
            } elsif ($event eq 'ui-matrix-changed') {
                die "Expected an updated matrix after browser evidence at the same source\n"
                    unless $state->{ui} eq 'yes' && $state->{head} eq $head &&
                    $state->{next} =~ /\A(?:mutations|opponent|final-review|done)\z/ &&
                    ($state->{widths_hash} // sha256_hex('')) ne feature_widths_hash($brief);
                $state->{next} = 'browser';
            } elsif ($event eq 'production-changed') {
                die "Expected a later product revision during testing or review\n"
                    unless $state->{next} =~ /\A(?:tests|browser|mutations|opponent|final-review)\z/
                    && $head ne $state->{head}
                    && system('git', '-C', $product, 'merge-base', '--is-ancestor', $state->{head}, $head) == 0;
                $state->{next} = 'early-review';
                $state->{mode} = 'D';
            } else {
                my $transition = $gate{$state->{next}}{$event}
                    or die "Unexpected event $event; next gate: $state->{next}\n";
                my ($next, $name, $label) = @$transition;
                verify_feature_widths($state, $brief) if $state->{next} =~ /\A(?:mutations|opponent|final-review)\z/;
                # The lead may have committed the role's implementation, fixes
                # or new tests after handing out the previous gate's revision.
                if ($state->{next} =~ /\A(?:implement|fix|tests)\z/) {
                    die "Diverged from previously recorded source\n"
                        if system('git', '-C', $product, 'merge-base', '--is-ancestor', $state->{head}, $head) != 0;
                } elsif ($state->{head} ne $head) {
                    die "Evidence is stale; reconcile and replan\n";
                }
                check_test_commits($product, $state, $head) if $state->{next} eq 'tests';
                if ($event eq 'early-pass') {
                    my $paths = $data->{test_paths} // [];
                    die "Expected exact reviewed test_paths\n" unless ref($paths) eq 'ARRAY';
                    for my $p (@$paths) {
                        die "Invalid approved test path\n" if !defined($p) || ref($p) || $p eq '' || $p =~ m{(?:\A/|/\z|//|(?:\A|/)\.git(?:/|\z))}i;
                        task_path("$product/" . encode('UTF-8', $p));
                    }
                    $state->{test_paths} = $paths;
                }
                die "Expected nonempty product diff for implementation\n"
                    if $event =~ /\A(?:implemented|fixed)\z/
                    && !length git_output('-C', $product, 'diff', '--name-only', $base, $head, '--');
                verify_feature_reports($dir, $state, $name);
                if (defined $name) {
                    my $report = feature_report($dir, $name);
                    my $observations = report_observations($report);
                    my $new = $observations;
                    if (my $old = $state->{observations}{$name}) {
                        die "Earlier observations changed in $name; reconcile and replan\n"
                            unless sha256_hex(substr($observations, 0, $old->{length})) eq $old->{hash};
                        $new = substr($observations, $old->{length});
                    }
                    # Latest decision for this phase wins, including rejection.
                    my $family = $label eq 'Full run' ? qr/Full run:/ :
                        $label =~ /APPROVED/ ? qr/(?:NOT APPROVED|APPROVED)/ :
                        $label =~ /\A(\w+) (?:PASS|FAIL|CHANGES)\z/ ? qr/\Q$1\E (?:PASS|FAIL|CHANGES)/ : qr/\Q$label\E/;
                    my @entries = $new =~ /^((?:$family) [^\r\n]+)\r?$/mg;
                    my $expected = $label eq 'Full run' ? "Full run: $head exit=0" : "$label $head";
                    die "Latest $name evidence disagrees with $event at $head\n"
                        unless @entries && ($event eq 'tests-fail'
                            ? $entries[-1] =~ /\AFull run: \Q$head\E exit=[1-9][0-9]*\z/
                            : $entries[-1] eq $expected);
                    if ($state->{next} eq 'early-review' || $state->{next} eq 'final-review') {
                        $review_by = check_local_review($product, $base, $head, $brief, $new, $state->{requires_opponent} eq 'yes');
                    }
                    if ($state->{next} eq 'browser' || $state->{next} eq 'mutations') {
                        my @runs = $observations =~ /^(Full run: [^\r\n]*)\r?$/mg;
                        die "Latest full run is stale or failed\n" unless @runs && $runs[-1] eq "Full run: $head exit=0";
                        if ($state->{next} eq 'mutations' && $state->{ui} eq 'yes') {
                            my @checks = $observations =~ /^(Browser (?:PASS|FAIL) [^\r\n]*)\r?$/mg;
                            die "Latest browser check is stale or failed\n" unless @checks && $checks[-1] eq "Browser PASS $head";
                        }
                    }
                    $state->{reports}{$name} = sha256_hex($report);
                    $state->{observations}{$name} = {length => length($observations), hash => sha256_hex($observations)};
                    $state->{widths_hash} = feature_widths_hash($brief) if $event eq 'browser-pass';
                }
                $state->{mode} = 'D' if $next eq 'fix';
                $next = 'mutations' if $next eq 'browser' && $state->{ui} eq 'no';
                $next = 'final-review' if $next eq 'opponent' && $state->{requires_opponent} eq 'no';
                $state->{next} = $next;
            }
        }
    }
    $state->{head} = $head;
    push @{$state->{history}}, {event => $event, head => $head, next => $state->{next}, mode => $state->{mode},
        defined $review_by ? (review_by => $review_by) : ()};
    die "Preflight changed while recording gate\n" if feature_report($task, 'preflight.md') ne $brief;
    die "Feature state changed while recording gate\n" unless
        defined($bytes) ? -f $path && read_file($path) eq $bytes : !-e $path;
    make_path(task_path($dir)) unless -d $dir;
    publish_task_file($path, JSON::PP->new->utf8->pretty->canonical->encode($state));
    print "Mode: $state->{mode}\nNext: $state->{next}\n";
}

1;
