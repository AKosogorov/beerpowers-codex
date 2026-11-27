use strict;
use warnings;
use utf8;
use File::Spec;

sub guard_project_shell {
    my ($root, $base, $name, @args) = @_;
    deny('guard-project-safety', 'Укажи рабочий каталог в параметрах инструмента.')
        if $name =~ /^(?:cd|set-location|sl|chdir)$/;
    deny('guard-project-safety', 'Команды sudo в проекте запрещены.') if $name eq 'sudo';
    if ($name =~ /^(?:rm|remove-item|ri)$/) {
        my ($recursive, $force);
        for my $arg (@args) {
            last if $arg eq '--';
            if ($arg =~ /^-(?:-recursive|recurse)$/i) { $recursive = 1 }
            elsif ($arg =~ /^--?force$/i) { $force = 1 }
            elsif ($name eq 'rm' && $arg =~ /^-[A-Za-z]+$/) {
                $recursive ||= $arg =~ /[rR]/;
                $force ||= $arg =~ /f/;
            }
        }
        deny('guard-project-safety', 'Принудительное рекурсивное удаление запрещено.') if $recursive && $force;
    }
    guard_project_artisan($root, $base, @args) if $name eq 'php';
}

sub guard_project_artisan {
    my ($root, $base, @args) = @_;
    while (@args && $args[0] =~ /^-/) {
        my $option = shift @args;
        last if $option =~ /\A(?:--|-f|--file)\z/;
        if ($option =~ /\A(?:-f|--file=)(.+)\z/) {
            unshift @args, $1;
            last;
        }
        next if $option =~ /\A(?:-n|--no-php-ini|-[cd].+|--(?:define|php-ini)=.+)\z/;
        return unless $option =~ /\A(?:-[cd]|--define|--php-ini)\z/ && @args;
        shift @args;
    }
    my $script = shift @args // return;
    shift @args if @args && $args[0] eq '--';
    my $command = shift @args // return;
    return unless $command =~ /\A(?:migrate:fresh|migrate:reset|db:wipe)\z/;
    $script =~ tr|\\|/|;
    return if $script !~ m{(?:^|/)artisan\z}i || dynamic_word($script);
    my $relative = File::Spec->abs2rel(path_at($base, $script), $root);
    $relative =~ tr|\\|/|;
    deny('guard-project-safety', "Команда Artisan $command запрещена.")
        if $script =~ m{\A(?:\./)?artisan\z}i ||
            $relative =~ m{\A(?:projects/[^/]+|worktrees/[^/]+/[^/]+)/(?:[^/]+/)*artisan\z}i;
}

sub guard_project_git {
    my ($sub, @args) = @_;
    deny('guard-project-safety', 'git clean запрещён в проекте.') if $sub eq 'clean';
    return unless $sub eq 'reset';
    for my $arg (@args) {
        last if $arg eq '--';
        deny('guard-project-safety', 'git reset --hard запрещён в проекте.') if $arg eq '--hard';
    }
}

1;
