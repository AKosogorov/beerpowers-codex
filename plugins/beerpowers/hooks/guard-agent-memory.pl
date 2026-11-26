use strict;
use warnings;
use utf8;

sub role_target {
    my ($project, $file) = @_;
    if ($project && $file =~ m{(?:^|/)\.codex/agent-memory(?:-local)?/}i
        && basename($file) !~ /^(?:MEMORY|feedback_[^\x2f]+)\.md$/) {
        deny('guard-agent-memory', 'В память роли пишутся только MEMORY.md и feedback_*.md. Проектные знания сохраняй в memory/.');
    }
}

1;
