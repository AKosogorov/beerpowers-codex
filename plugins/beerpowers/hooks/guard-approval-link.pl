use strict;
use warnings;
use utf8;

sub guard_approval_link {
    my ($project, $input) = @_;
    exit 0 unless $project && enabled('guard-approval-link') && ref $input eq 'HASH' && ref $input->{questions} eq 'ARRAY';
    my $questions = JSON::PP->new->canonical->encode($input->{questions});
    exit 0 unless $questions =~ /утвержд|бриф|черновик|план|approv|brief|\bADR\b/i;
    exit 0 if $questions =~ /\.md\b|memory[\\\/]+(?:tasks|adr)[\\\/]/i;
    my $file = state_file('approval');
    context('guard-approval-link: приложи ссылку на утверждаемый документ.') unless defined $file;
    my $sum = sha256_hex(encode('UTF-8', $questions));
    if (seen($file, $sum)) { unlink $file; exit 0 }
    remember($file, $sum);
    deny('guard-approval-link', 'Приложи путь к артефакту в вопросе. Если вопрос не об утверждении, повтори его.');
}

1;
