use strict;
use warnings;
use utf8;

sub role_reader_tool {
    my ($input, $root, $cwd) = @_;
    return unless $cwd eq $root && ref($input) eq 'HASH' &&
        !grep { !/\A(?:cmd|command|login|max_output_tokens|yield_time_ms)\z/ } keys %$input;
    return if exists($input->{cmd}) && exists($input->{command});
    return if exists($input->{cmd}) && (!JSON::PP::is_bool($input->{login}) || $input->{login});
    my $cmd = $input->{cmd} // $input->{command};
    return if !defined($cmd) || ref($cmd) || ($input->{login} // 0);
    my $windows = $^O eq 'cygwin' || $^O eq 'MSWin32';
    my $binary = $windows ? 'node.exe' : 'node';
    my ($node) = $ENV{BEERPOWERS_NODE} || grep { -f $_ && File::Spec->file_name_is_absolute($_) }
        map { File::Spec->catfile($_, $binary) } File::Spec->path();
    return unless defined $node;
    $node = Cygwin::win_to_posix_path($node) if $^O eq 'cygwin' && $node =~ m{^(?:[A-Za-z]:[/\\]|\\\\)};
    my @files = map { abs_path($_) || return } ($node, "$Bin/../bin/role-files.mjs");
    if ($^O eq 'cygwin') { @files = map { Cygwin::posix_to_win_path($_, 1) } @files }
    for (@files) { tr{\\}{/}; return unless m{\A[\pL\pM\pN _.:/()\-]+\z} }
    my $prefix = ($windows ? '& ' : '') . join(' ', map { "'$_'" } @files);
    # Both shells receive literal data. Other options, substitutions and operators are outside this grammar.
    my $arg = qr/'[\pL\pM\pN _.:\/*?+\-]+'/;
    return 'Read' if $cmd =~ /\A\Q$prefix\E Read $arg\z/;
    return $1 if $cmd =~ /\A\Q$prefix\E (Grep|Glob) $arg $arg\z/;
    return;
}

sub role_web_allowed {
    my ($allow, $input) = @_;
    return unless ref($input) eq 'HASH';
    my %operations = (search_query => 'WebSearch', open => 'WebFetch');
    my @ops = grep { $_ ne 'response_length' } keys %$input;
    return @ops && !grep { !exists $operations{$_} || !$allow->{$operations{$_}} ||
        ref($input->{$_}) ne 'ARRAY' || !@{$input->{$_}} } @ops;
}

# Host IDs opaque: only a digest enters the filesystem. An unbound session keeps its normal policy.
sub guard_role_tools {
    my ($event, $root, $cwd, $json, $tool, $input) = @_;
    my $dir = "$root/.codex/.cache/role-tools";
    return unless -d $dir;
    my $file;
    for my $id ($event->{agent_id}, $event->{session_id}) {
        next unless defined $id && !ref $id && length $id;
        my $candidate = "$dir/" . sha256_hex(encode('UTF-8', $id)) . '.json';
        if (-e $candidate) { $file = $candidate; last }
    }
    return unless defined $file;
    my $p = !-l $file && eval { $json->decode(raw_file($file)) };
    deny('role-tools', 'Не удалось прочитать привязку инструментов роли.')
        unless ref($p) eq 'HASH' && ref($p->{tools}) eq 'ARRAY';
    my %allow = map { $_ => 1 } @{$p->{tools}};
    if ($tool =~ /\A(?:web__run|web\.run)\z/) {
        return if role_web_allowed(\%allow, $input);
        deny('role-tools', 'Запрос web.run требует разрешения на каждую операцию поиска или чтения.');
    }
    if ($tool =~ /\A(?:functions\.)?exec_command\z/ || $tool eq 'Bash') {
        my $reader = role_reader_tool($input, $root, $cwd);
        return if $reader && $allow{$reader};
    }
    return if $allow{$tool} && $tool !~ /\A(?:functions\.)?exec\z/;
    my %native = (
        'functions.exec_command' => 'Bash', exec_command => 'Bash',
        'functions.write_stdin' => 'Bash', write_stdin => 'Bash',
        'collaboration.send_message' => 'SendMessage',
        'web.search_query' => 'WebSearch', 'web.open' => 'WebFetch',
    );
    return if exists $native{$tool} && $allow{$native{$tool}};
    if ($tool =~ /^(?:functions\.)?apply_patch$/) {
        my $patch = ref($input) eq 'HASH' ? ($input->{command} // $input->{patch} // '') : ($input // '');
        my @ops = $patch =~ /^\*{3} (Add|Update|Delete|Move)(?: File| to)?: /mg;
        return if @ops && !grep { !$allow{$_ eq 'Add' ? 'Write' : 'Edit'} } @ops;
    }
    deny('role-tools', "Бриф $p->{role} не разрешает операцию $tool. Передай блокер тимлиду.");
}
1;
