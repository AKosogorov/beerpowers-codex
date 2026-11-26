use strict;
use warnings;
use utf8;

sub setup_window {
    my $window = state_file('setup');
    my $setup_root = defined $window && -f $window && time - (stat $window)[9] < 6*3600
        ? decode('UTF-8', raw_file($window)) : undef;
    return ($window, $setup_root);
}

sub setup_prompt {
    my ($root, $window, $event) = @_;
    my $prompt = $event->{prompt} // '';
    if ($prompt =~ /^\s*(?:\$beerpowers\b|\[\$beerpowers\]\([^\r\n)]*\))\s+(setup|onboard|product-onboard)\b/) {
        context('guard-user-files advisory: нет PLUGIN_DATA или session_id. Сохрани существующие файлы.') unless $window;
        remember($window, encode('UTF-8', $root));
    } elsif ($prompt =~ /^\s*(?:\$beerpowers\b|\[\$beerpowers\]\(|\/\w)/ && defined $window && -e $window) {
        unlink $window or die "close setup: $!";
    }
}

sub setup_stop {
    my ($window, $setup_root, $event) = @_;
    unlink $window if defined $setup_root && ($event->{last_assistant_message} // '') =~ /\bProject OK\b/;
}

sub protected_existing {
    my ($setup_root, $file) = @_;
    return 0 unless -e $file || -l $file;
    return 0 if defined $setup_root && index("$file/", "$setup_root/memory/tasks/") == 0;
    return 0 if defined $setup_root && index("$file/", "$setup_root/.codex/.cache/") == 0;
    return 1;
}
sub changed_path {
    my ($project, $setup_root, $action, $file) = @_;
    role_target($project, $file);
    if (defined $setup_root && $action ne 'Update' && protected_existing($setup_root, $file)) {
        deny('guard-user-files', 'Во время setup существующий файл можно дополнить точечной правкой. Замена, перенос или удаление запрещены.');
    }
}

sub guard_setup_git {
    my ($sub, @args) = @_;
    if ($sub =~ /^(?:rm|mv|clean|restore)$/ ||
        ($sub eq 'reset' && grep { $_ eq '--hard' } @args) ||
        ($sub eq 'checkout' && grep { $_ eq '--' || $_ eq '.' } @args)) {
        deny('guard-user-files', 'Во время setup нельзя удалять, переносить и восстанавливать пользовательские файлы.');
    }
}

sub guard_setup_shell {
    my ($name) = @_;
    if ($name =~ /^(?:rm|rmdir|unlink|del|erase|rd|remove-item|ri|mv|move|move-item|ren|rename-item)$/) {
        deny('guard-user-files', 'Во время setup операции удаления и переноса файлов требуют отдельной задачи.');
    }
}

1;
