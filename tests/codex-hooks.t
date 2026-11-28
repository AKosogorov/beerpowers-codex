use strict;
use warnings;
use utf8;
use Test::More;
use JSON::PP ();
use Digest::SHA qw(sha256_hex);
use Encode qw(encode);
use File::Path qw(make_path);
use File::Copy qw(copy);
use File::Temp qw(tempdir);
use File::Basename qw(dirname);
use IPC::Open2;
use Cwd qw(abs_path getcwd);
BEGIN { $0 = Cygwin::win_to_posix_path($0) if $^O eq 'cygwin' && $0 =~ /\\/ }
use FindBin qw($Bin);

my $pkg = abs_path("$Bin/../plugins/beerpowers");
my $tmp = tempdir(CLEANUP => 1);
my $ws = "$tmp/team space";
my $repo = "$ws/projects/ledger app";
my $oldcwd = getcwd();
END { chdir $oldcwd if defined $oldcwd }
my $json = JSON::PP->new->utf8->canonical;
$ENV{PLUGIN_ROOT} = $pkg;
$ENV{PLUGIN_DATA} = "$tmp/plugin data";
my @runner = ($^X, "$pkg/hooks/dispatch.pl");
my $session = 'fixture session';
my $cwd = $ws;
sub put {
    my ($file,$body) = @_;
    make_path(dirname($file));
    open my $fh, '>:raw', $file or die $!;
    print {$fh} $body;
    close $fh or die $!;
}
sub read_file {
    open my $fh, '<:raw', $_[0] or die $!;
    local $/; return scalar <$fh>;
}
sub run_event {
    my ($kind, %values) = @_;
    my $pid = open2(my $out, my $in, @runner);
    binmode $in, ':raw'; binmode $out, ':raw';
    print {$in} $json->encode({hook_event_name=>$kind, session_id=>$session, cwd=>$cwd, %values});
    close $in;
    local $/;
    my $result = <$out> // '';
    close $out;
    waitpid $pid, 0;
    die "hook exit $? ($kind)" if $?;
    return length $result ? $json->decode($result) : {};
}
sub hook {
    my ($tool, $cmd, $kind) = @_;
    return run_event($kind // 'PreToolUse', tool_name=>$tool, tool_input=>{command=>$cmd})->{hookSpecificOutput} // {};
}
sub shell { hook('Bash', $_[0]) }
sub decision { $_[0]->{permissionDecision} // 'pass' }
sub denied { my ($out,$guard,$label)=@_; is(decision($out),'deny',$label); like($out->{permissionDecisionReason}//'',qr/^\Q$guard\E:/,"$label reason") }
sub allowed { my ($out,$label)=@_; is_deeply($out,{},$label) }
sub git_repo {
    system('git','-C',$repo,@_) == 0 or die "fixture git @_";
}
sub patch { "*** Begin Patch\n$_[0]\n*** End Patch" }
sub assert_rules {
    my ($kind, $mask) = @_;
    my @keys = qw(reply_blocking_asks reply_file_links reply_user_shell);
    my $ctx = run_event($kind)->{hookSpecificOutput}{additionalContext} // '';
    for my $i (0..$#keys) {
        my $rule = $keys[$i];
        require Encode;
        my $body = Encode::decode('UTF-8', read_file("$pkg/rules/$rule.md"));
        ok((index($ctx,$body)>=0) == !!($mask & 1<<$i), "$rule combination $mask");
    }
}

make_path($ws,$repo);
chdir $ws or die $!;
my $cfg = "$ws/.codex/barriers.json";
my $registration = $json->decode(read_file("$pkg/hooks/hooks.json"))->{hooks};
is_deeply([sort keys %$registration],[sort qw(SessionStart UserPromptSubmit PreToolUse PostToolUse SubagentStart SubagentStop Stop)],'registered lifecycle');
for my $kind (keys %$registration) {
    is(scalar(map { @{$_->{hooks}} } @{$registration->{$kind}}), 1, "$kind registers one handler");
    my $handler = $registration->{$kind}[0]{hooks}[0];
    is($handler->{type},'command',"$kind uses synchronous command");
    ok(!$handler->{async} && $handler->{commandWindows} && $handler->{command},"$kind portable launchers");
}
my $matcher = $registration->{PreToolUse}[0]{matcher};
like($_,qr/$matcher/,"matcher $_") for qw(Bash apply_patch request_user_input functions.request_user_input_async exec functions.exec_command);
for my $mask (0..7) {
    local @ENV{qw(BEERPOWERS_REPLY_BLOCKING_ASKS BEERPOWERS_REPLY_FILE_LINKS BEERPOWERS_REPLY_USER_SHELL)} =
        map { $mask & 1<<$_ ? 'true' : 'false' } 0..2;
    assert_rules('SessionStart',$mask);
}
{
    local @ENV{qw(BEERPOWERS_REPLY_BLOCKING_ASKS BEERPOWERS_REPLY_FILE_LINKS BEERPOWERS_REPLY_USER_SHELL)};
    assert_rules('SessionStart',7);
}
is_deeply(run_event('SubagentStart',agent_type=>'tester'),{},'no global reply rules on SubagentStart');
is_deeply(run_event('SessionStart',agent_id=>'worker'),{},'subagent-marked start skips global rules');
allowed(shell('git push origin main'),'no charter skips project guard');
put("$ws/AGENTS.md","Original\n");
run_event('UserPromptSubmit',prompt=>'$beerpowers setup');
denied(hook('apply_patch',patch('*** Delete File: AGENTS.md')),'guard-user-files','before first setup');
run_event('UserPromptSubmit',prompt=>'continue');
denied(shell('Set-Content -LiteralPath "AGENTS.md" -Value changed'),'guard-user-files','PowerShell overwrite');
denied(shell('echo example > AGENTS.md'),'guard-user-files','Bash overwrite');
make_path("$ws/fresh");
allowed(shell('Copy-Item -LiteralPath AGENTS.md -Destination fresh'),'copy makes a new file in existing directory');
put("$ws/fresh/AGENTS.md","Original\n");
denied(shell('Copy-Item -LiteralPath AGENTS.md -Destination fresh'),'guard-user-files','copy targets protected existing file in directory');
allowed(shell('echo example >> AGENTS.md'),'append allowed');
allowed(hook('apply_patch',patch("*** Update File: AGENTS.md\n@@\n+more")),'surgical patch allowed');
allowed(hook('apply_patch',patch("*** Add File: new.md\n+new")),'new file allowed');
denied(hook('apply_patch',patch("*** Update File: AGENTS.md\n*** Move to: moved.md\n@@\n-ok\n+new")),'guard-user-files','rename source');
{
    my $result = run_event('PreToolUse',session_id=>'another session',tool_name=>'Bash',tool_input=>{command=>'rm AGENTS.md'});
    is_deeply($result,{},'setup state is per session');
}
run_event('Stop',last_assistant_message=>'Need a project choice');
denied(shell('rm AGENTS.md'),'guard-user-files','pending setup persists across turns');
run_event('Stop',last_assistant_message=>'Project OK');
allowed(shell('rm AGENTS.md'),'successful setup closes window');
run_event('UserPromptSubmit',prompt=>'[$beerpowers](skill://beerpowers) setup');
denied(shell('git restore AGENTS.md'),'guard-user-files','skill mention opens window');
run_event('UserPromptSubmit',prompt=>'$beerpowers doctor');
allowed(shell('git restore AGENTS.md'),'another command closes window');

put("$ws/.codex/team-charter.md","fixture\n");
my $safety = "$ws/.codex/rules/beerpowers-safety.rules";
put($safety, "# fixture policy installed\n");
for my $case (
    'cd projects', 'sudo -n true', 'rm -r -f scratch', 'Remove-Item scratch -Recurse -Force',
    'git -C "projects/ledger app" reset --hard', 'git -C worktrees/T-1/catalog clean -fd',
    'php "projects/ledger app/artisan" migrate:fresh', 'php worktrees/T-1/catalog/artisan db:wipe',
    '& php.exe .\\worktrees\\T-1\\catalog\\artisan migrate:reset',
    'php -n -d memory_limit=256M -f projects/catalog/artisan -- migrate:reset',
    qq{php "$repo/artisan" db:wipe},
) {
    denied(shell($case), 'guard-project-safety', "project policy blocks $case");
}
denied(hook('exec_command','php worktrees/T-1/catalog/artisan db:wipe'),
    'guard-project-safety','direct exec_command event');
allowed(shell('git -C "projects/ledger app" status --short'),'project policy permits Git status');
allowed(shell('php projects/catalog/artisan migrate:status'),'project policy permits Artisan status');
allowed(shell('php -f projects/catalog/artisan -- migrate:status'),'project policy permits status with explicit PHP script');
allowed(shell('git reset --soft HEAD~1'),'project policy permits soft reset');
unlink $safety or die $!;
put("$ws/.codex/workspace.json",$json->encode({beerpowers=>'0.2.0'}));
git_repo('init','-q','-b','main');
put("$repo/tracked.py","print(1)\n");
git_repo('add','tracked.py');
git_repo('-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-qm','base');
git_repo('symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/trunk');
my $session_start = run_event('SessionStart')->{hookSpecificOutput}{additionalContext};
like($session_start,qr/0\.2\.0.*doctor/s,'charter drift message');
$cwd = $repo;
denied(shell('git push origin main'),'guard-push','child cwd finds charter');
denied(shell('git push origin feature HEAD:trunk'),'guard-push','second refspec and remote HEAD');
denied(shell('git push --force origin feature'),'guard-push','bare force');
denied(shell('git push origin :feature'),'guard-push','delete refspec');
denied(shell('git push --mirror origin'),'guard-push','mirror');
git_repo('remote','add','fixture-gitlab','https://gitlab.invalid/example');
denied(shell('git push fixture-gitlab PROJ-1'),'guard-push','GitLab first task push requires MR');
allowed(shell('git push fixture-gitlab PROJ-1 -o merge_request.create'),'GitLab task with MR option');
denied(shell('powershell -NoProfile -Command "git push origin main"'),'guard-push','PowerShell literal nested command');
denied(shell('cmd /c "bash -lc \'git push origin main\'"'),'guard-push','two nested shells');
denied(shell('bash opaque-script.sh; git push origin main'),'guard-push','opaque earlier segment preserves later deny');
denied(shell('& git.exe push origin main'),'guard-push','PowerShell call operator');
allowed(shell('git push --force-with-lease origin feature'),'explicit feature ref');
allowed(shell('echo "git push origin main"'),'quoted data');
my $probe_remote = "$tmp/push-probe.git";
system('git','init','-q','--bare',$probe_remote) == 0 or die 'prepare probe remote';
my $probe = shell(qq{git -C "$repo" push "$probe_remote" HEAD:refs/heads/main});
denied($probe,'guard-push','literal git -C cannot update the protected branch');
git_repo('push','-q',$probe_remote,'HEAD:refs/heads/main') unless decision($probe) eq 'deny';
is(system('git','-C',$probe_remote,'show-ref','--verify','--quiet','refs/heads/main') >> 8, 1,
    'protected ref remains absent when the command runner honors deny');
denied(shell('Stop-Process -Name dummy'),'guard-kill','PowerShell process name');
denied(shell('Write-Output ok; taskkill.exe /F /IM nothing.exe'),'guard-kill','later command');
allowed(shell('Stop-Process -Id 999999'),'own PID shape');
denied(shell('cat payload | python3'),'guard-stdin-code','interpreter pipeline');
denied(shell('Get-Content file | python.exe -'),'guard-stdin-code','PowerShell pipeline');
denied(shell("python - <<'INPUT'\nprint(1)\nINPUT"),'guard-stdin-code','interpreter heredoc');
allowed(shell('python check.py < data'),'script reads data');
put($cfg,$json->encode({'guard-kill'=>JSON::PP::false}));
allowed(shell('pkill dummy'),'single off flag');
denied(shell('git push origin main'),'guard-push','other flags unchanged');
put($cfg,'{}');

my $memory = "$ws/.codex/agent-memory/tester";
make_path($memory);
my $bad = patch("*** Add File: $memory/facts.md\n+value");
denied(hook('apply_patch',$bad),'guard-agent-memory','raw patch absolute memory path');
my $windows = $^O eq 'cygwin' ? Cygwin::posix_to_win_path($memory) : $memory;
$windows =~ tr|/|\\|;
denied(hook('apply_patch',patch("*** Add File: $windows\\facts.md\n+value")),'guard-agent-memory','Windows separators');
denied(shell("apply_patch <<'PATCH'\n$bad\nPATCH"),'guard-agent-memory','Bash heredoc patch');
denied(shell("bash -lc \"apply_patch <<'PATCH'\n$bad\nPATCH\""),'guard-agent-memory','nested Bash heredoc patch');
denied(shell("cd '$ws'; apply_patch <<'PATCH'\n" . patch("*** Add File: .codex/agent-memory/tester/facts.md\n+test") . "\nPATCH"),
    'guard-agent-memory','nested relative patch after change of directory');
denied(shell("Set-Content -LiteralPath '$memory/facts.md' -Value dummy"),'guard-agent-memory','PowerShell file write');
denied(hook('apply_patch',patch("*** Update File: ok.md\n*** Move to: $memory/notes.md\n@@\n-x\n+y")),'guard-agent-memory','patch rename destination');
allowed(hook('apply_patch',patch("*** Add File: $memory/feedback_example.md\n+value")),'feedback allowed');
allowed(hook('apply_patch',patch("*** Update File: $memory/MEMORY.md\n@@\n+value")),'index allowed');
my $opaque = run_event('PreToolUse',tool_name=>'functions.exec',tool_input=>{code=>'await tools.exec_command(...)'});
like($opaque->{hookSpecificOutput}{additionalContext},qr/advisory/,'opaque outer JS advisory');
ok(!exists $opaque->{hookSpecificOutput}{permissionDecision},'opaque outer JS makes no permission decision');
put("$repo/tracked.py","print(1)\n# Keep example small\n");
git_repo('add','tracked.py');
denied(shell('git commit -m fixture'),'guard-comments','real index added comment');
allowed(shell('git commit -m fixture'),'second read of same comment set');
put("$repo/tracked.py","C2 = 1  # local setting\n");
git_repo('add','tracked.py');
unlike(shell('git commit -m fixture')->{permissionDecisionReason},qr/контекст задачи/,'charter marker in code alone is unrelated');
put("$repo/tracked.py",encode('UTF-8',"C2 = 1  # см. ответ 2 и memory/tasks/X\n"));
git_repo('add','tracked.py');
like(shell('git commit -m fixture')->{permissionDecisionReason},qr/контекст задачи.*# см\. ответ 2/s,'warn about ephemeral task references in comment only');
put("$repo/generated/calc.ts","const value = price * count;\n");
git_repo('add','generated/calc.ts');
allowed(shell('git commit -- generated/calc.ts'),'multiplication is not a block comment');
put("$repo/generated/calc.ts","/* read value */\n");
git_repo('config','color.ui','always');
denied(shell('git commit -- generated/calc.ts'),'guard-comments','colored Git configuration preserves the comment check');
put($cfg,$json->encode({comments=>{excludeDirs=>['projects/ledger app/generated/']}}));
put("$repo/generated/calc.ts","/* new generated comment */\n");
allowed(shell('git commit -- generated/calc.ts'),'exclude generated subtree with trailing slash');
put($cfg,'{}');
git_repo('config','--unset','color.ui');
git_repo('restore','--staged','generated/calc.ts');
put("$repo/memory/tasks/one/spec.md","fixture\n");
git_repo('add','memory/tasks/one/spec.md');
denied(shell('git commit -m fixture'),'guard-commit-split','real mixed index');
allowed(shell('git commit -- memory/tasks/one/spec.md'),'commit of one explicit path');
denied(shell('git commit -- memory/tasks/one/spec.md tracked.py'),'guard-commit-split','mixed explicit paths');
denied(shell('git commit -am fixture'),'guard-commit-split','mixed -a paths');
denied(shell('git commit --include tracked.py -m fixture'),'guard-commit-split','--include retains staged task file');
allowed(shell('git commit --only memory/tasks/one/spec.md -m fixture'),'--only excludes other staged files');
like(shell('git commit --pathspec-from-file=selection.txt')->{additionalContext},qr/advisory/,'pathspec file contents unsupported');
put("$repo/.gitattributes", "tracked.py filter=hookfixture\n");
git_repo('config','filter.hookfixture.clean','exit 1');
git_repo('config','filter.hookfixture.required','true');
put("$repo/tracked.py", "print(2)\n# Working copy comment\n");
denied(shell('git commit -- tracked.py'),'guard-comments','worktree diff does not execute configured clean filter');
put("$repo/.gitattributes", "");
git_repo('-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-qm','second fixture');
git_repo('update-ref','refs/remotes/origin/demo','HEAD');
denied(shell('git push --force-with-lease origin HEAD~1:demo'),'guard-push','lease would lose local remote-tracking commit');
allowed(shell('git push --force-with-lease origin HEAD~1:demo'),'lost pair already shown');
sub ask {
    my ($title)=@_;
    return run_event('PreToolUse',tool_name=>'request_user_input_async',tool_input=>{questions=>[{title=>$title}]})->{hookSpecificOutput} // {};
}
denied(ask('Утверждаешь бриф?'),'guard-approval-link','question requires link');
allowed(ask('Утверждаешь бриф?'),'same question can repeat');
allowed(ask('Утверждаешь plan.md?'),'linked question');
put($cfg,$json->encode({map { $_=>JSON::PP::false } qw(guard-push guard-comments guard-commit-split guard-approval-link guard-kill guard-stdin-code)}));
allowed(shell('git push origin main'),'push off');
allowed(shell('Stop-Process -Name dummy'),'kill off');
allowed(shell('cat file | python'),'stdin off');
allowed(shell('git commit -m test'),'comments and split off');
allowed(ask('Утверждаешь бриф?'),'approval link off');
denied(hook('apply_patch',$bad),'guard-agent-memory','role memory stays on with all switches off');
put($cfg,'{}');

put("$ws/.codex/quality-gates.txt","# ordered\n*/migrations/* Migration gate\n*.php PHP gate\n");
my $quality = hook('apply_patch',patch("*** Add File: migrations/new.php\n+x\n*** Add File: app.php\n+x"),'PostToolUse');
like($quality->{additionalContext},qr/Migration gate.*PHP gate/s,'all changed patch paths receive first matching quality instruction');
my $post_matcher = $registration->{PostToolUse}[0]{matcher};
like('functions.exec', qr/$post_matcher/, 'PostToolUse subscribes to Code mode');
for my $kind (qw(PreToolUse PostToolUse)) {
    my $value = $kind eq 'PreToolUse' ? $bad : patch("*** Add File: migrations/item.php\n+x");
    my $code = 'text(await tools.apply_patch(' . Encode::decode('UTF-8',$json->encode($value)) . '))';
    my $result = run_event($kind, tool_name => 'functions.exec', tool_input => {code => $code})->{hookSpecificOutput};
    if ($kind eq 'PreToolUse') { denied($result, 'guard-agent-memory', 'nested patch for unbound team lead'); }
    else { like($result->{additionalContext}, qr/Migration gate/, 'nested patch triggers quality reminder after the edit'); }
    my $unknown = run_event($kind, tool_name => 'functions.exec', tool_input => {code => $code . '; text(1)'})->{hookSpecificOutput};
    like($unknown->{additionalContext}//'', qr/advisory/, "$kind opaque program retains advisory");
}
is_deeply(hook('apply_patch',patch("*** Add File: new.js\n+x"),'PostToolUse'),{},'unmatched quality mask');
put("$ws/.codex/quality-gates.txt","*.vue|*.ts Combined\n*.vue Later\n");
for my $file ('projects/web/src/form.vue','worktrees/T/web/form.ts') {
    like(hook('apply_patch',patch("*** Add File: $file\n+x"),'PostToolUse')->{additionalContext},qr/^Combined$/,'first alternative rule for '.$file);
}
put("$ws/.codex/quality-gates.txt", "*/projects/web/*.vue|*/worktrees/*/web/*.vue Lint Vue\n" .
    "*/projects/web/*|*/worktrees/*/web/* Build web\n");
for my $base ('projects/web', 'worktrees/T/web') {
    for my $case (['src/form.vue', 'Lint Vue'], ['Dockerfile', 'Build web']) {
        my ($file, $expected) = @$case;
        my $event = hook('apply_patch',patch("*** Add File: $base/$file\n+x"),'PostToolUse');
        is($event->{additionalContext}, $expected, "first relevant gate for $base/$file");
    }
}
put("$ws/.codex/quality-gates.txt",'');
is_deeply(hook('apply_patch',patch("*** Add File: form.vue\n+x"),'PostToolUse'),{},'empty rules disable reminder');
my $stop = run_event('SubagentStop',agent_type=>'tester',agent_id=>'tester-1');
ok($stop->{systemMessage} && !$stop->{decision},'stop suggests checking artifacts');
put($cfg,$json->encode({'screenshots-reminder'=>JSON::PP::true}));
my $one = "$ws/memory/tasks/one";
my $two = "$ws/memory/tasks/area/two";
put("$one/preflight.md", "Task one\n");
put("$two/preflight.md", "Task two\n");
my $shot = "$one/screenshots/tester-screen.png";
put($shot, 'old screenshot');
my $old = time - 3600;
utime($old, $old, $shot) == 1 or die "age screenshot: $!";
my %tester = (agent_type=>'tester', agent_id=>'tester-1');
my %other = (agent_type=>'testing-agent', agent_id=>'tester-2');
like(run_event('SubagentStart', %tester, cwd=>$one)->{hookSpecificOutput}{additionalContext},qr/tester-/,'tester gets screenshot instructions');
my $worktree = "$ws/worktrees/area/two/ledger app";
git_repo('worktree','add','-q','-b','area/two',$worktree,'HEAD');
make_path("$worktree/src");
run_event('SubagentStart', %other, cwd=>"$worktree/src");
is(run_event('SubagentStop', %other)->{decision},'block','worktree binds to task two before its screenshot exists');
%other = (%other, agent_id=>'tester-2-fresh');
run_event('SubagentStart', %other, cwd=>"$worktree/src");
put("$two/screenshots/tester-screen.webp", 'fresh screenshot for task two');
is(run_event('SubagentStop', %tester)->{decision},'block','fresh neighboring screenshot cannot satisfy task one');
ok(!run_event('SubagentStop', %tester)->{decision},'no continuation loop even without stop_hook_active');
ok(!run_event('SubagentStop', %other)->{decision},'fresh screenshot for the task of the worktree is accepted');

my %next = (agent_type=>'tester', agent_id=>'tester-3', cwd=>$one);
run_event('SubagentStart', %next);
ok(!run_event('SubagentStop', %next, last_assistant_message=>'Скриншоты не приложены: правка затрагивает только API.')->{decision},'explicit reason accepts a report without a screenshot');
my $blank = run_event('SubagentStop', %next, last_assistant_message=>'Скриншоты не приложены:   ');
is($blank->{decision}, 'block', 'empty reason does not count');
put($shot, 'fresh screenshot for task one');
my %fresh = (agent_type=>'tester', agent_id=>'tester-4', cwd=>$one);
run_event('SubagentStart', %fresh);
put($shot, 'fresh screenshot from this run');
ok(!run_event('SubagentStop', %fresh)->{decision},'fresh own screenshot is accepted');

my %unknown = (agent_type=>'tester', agent_id=>'tester-5', cwd=>$repo);
run_event('SubagentStart', %unknown);
my $advisory = run_event('SubagentStop', %unknown);
ok(!$advisory->{decision} && $advisory->{systemMessage} =~ /tester-/, 'shared checkout sends explicit task evidence advisory');
$advisory = run_event('SubagentStop', agent_type=>'tester', agent_id=>'before-start', cwd=>$one);
ok(!$advisory->{decision} && $advisory->{systemMessage} =~ /tester-/, 'stop without a recorded start sends advisory');
my $legacy = sha256_hex(join "\0", $session, 'screenshots', 'legacy-tester');
put("$ENV{PLUGIN_DATA}/hook-state/$legacy", time - 60);
$advisory = run_event('SubagentStop', agent_type=>'tester', agent_id=>'legacy-tester', cwd=>$one);
ok(!$advisory->{decision} && $advisory->{systemMessage} =~ /tester-/, 'legacy timestamp cannot bind a task');
$advisory = run_event('SubagentStop', %fresh, cwd=>$two);
ok(!$advisory->{decision} && $advisory->{systemMessage} =~ /tester-/, 'conflicting task paths send advisory');
put("$two/notes/test-cases.md", "Nested task marker\n");
$advisory = run_event('SubagentStop', %other, cwd=>"$two/notes");
ok(!$advisory->{decision} && $advisory->{systemMessage} =~ /tester-/, 'ambiguous task paths send advisory');
my %continued = (agent_type=>'tester', agent_id=>'tester-6', cwd=>$one);
utime($old, $old, $shot) == 1 or die "age screenshot: $!";
run_event('SubagentStart', %continued);
ok(!run_event('SubagentStop', %continued, stop_hook_active=>JSON::PP::true)->{decision}, 'active stop hook cannot request another continuation');
ok(!run_event('SubagentStop',agent_type=>'worker',agent_id=>'worker-1')->{decision},'generic worker is not assumed to be tester');

# Use each actual configured launcher with the same safe input. Commands under test stay inert.
my $portable = $registration->{PreToolUse}[0]{hooks}[0];
my $copied = "$tmp/copied plugin";
for my $dir (qw(hooks templates/hooks rules .codex-plugin)) {
    make_path("$copied/$dir");
    opendir my $source, "$pkg/$dir" or die $!;
    while (defined(my $name = readdir $source)) {
        next unless -f "$pkg/$dir/$name";
        copy("$pkg/$dir/$name", "$copied/$dir/$name") or die $!;
    }
}
$ENV{PLUGIN_ROOT} = $copied;
@runner = ('sh','-c',$portable->{command});
denied(shell('git push origin main'),'guard-push','Git Bash / POSIX registered launcher');
my $post = $registration->{PostToolUse}[0]{hooks}[0];
@runner = ('sh','-c',$post->{command});
put("$ws/.codex/quality-gates.txt", "*.vue Quality gate\n");
is(hook('apply_patch',patch("*** Add File: form.vue\n+x"),'PostToolUse')->{additionalContext},
   'Quality gate', 'registered launcher loads reminder from copied package');
if ($^O eq 'cygwin' || $^O eq 'MSWin32') {
    my $cmd = $ENV{COMSPEC} // 'cmd.exe';
    local $ENV{MSYS2_ARG_CONV_EXCL} = '*';
    local $ENV{PLUGIN_ROOT} = Cygwin::posix_to_win_path($copied) if $^O eq 'cygwin';
    # Pass the registered line verbatim to cmd. Cygwin spawn otherwise adds
    # C-runtime backslash escapes around quotes, which cmd treats literally.
    my $batch = "$tmp/run-hook.cmd";
    put($batch, "\@echo off\r\n$portable->{commandWindows}\r\n");
    my $batch_path = $^O eq 'cygwin' ? Cygwin::posix_to_win_path($batch) : $batch;
    @runner = ($cmd,'/D','/C',$batch_path);
    denied(shell('git push origin main'),'guard-push','registered cmd.exe /C PowerShell launcher');
    allowed(shell('git push origin feature'),'registered cmd.exe /C allow path');
    @runner = ('powershell.exe','-NoLogo','-NoProfile','-NonInteractive','-Command',$portable->{commandWindows});
    denied(shell('git push origin main'),'guard-push','registered PowerShell launcher with spaces in plugin path');
    allowed(shell('git push origin feature'),'registered PowerShell allow path');
}
done_testing();
