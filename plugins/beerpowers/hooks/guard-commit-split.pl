use strict;
use warnings;
use utf8;

sub guard_commit_split {
    my ($repo, $diff, $ranges) = @_;
    my @files = map { split /\0/, git_read($repo, @$diff, '--name-only', '-z', @$_) } @$ranges;
    if ((grep { m{^memory/tasks/} } @files) && (grep { !m{^memory/tasks/} } @files)) {
        deny('guard-commit-split', 'В коммите смешаны memory/tasks/ и другие файлы. Разнеси артефакты задачи и изменения проекта.');
    }
}

1;
