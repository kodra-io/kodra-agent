import jenkins.model.*
import com.cloudbees.hudson.plugins.folder.Folder
import hudson.plugins.git.BranchSpec
import hudson.plugins.git.GitSCM
import org.jenkinsci.plugins.workflow.job.WorkflowJob
import org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition
import org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition
def j = Jenkins.get()
def folder = j.getItem('team-a') ?: j.createProject(Folder, 'team-a')
def job = folder.getItem('deploy-web') ?: folder.createProject(WorkflowJob, 'deploy-web')
job.setDefinition(new CpsFlowDefinition("node { echo 'hello' }", true))
job.save()
// A job that runs a repo's Jenkinsfile, found by its git URL (B5). Never built.
def app = folder.getItem('demo-app') ?: folder.createProject(WorkflowJob, 'demo-app')
def scm = new GitSCM(GitSCM.createRepoList('https://github.com/acme/demo-app.git', null), [new BranchSpec('*/main')], null, null, [])
app.setDefinition(new CpsScmFlowDefinition(scm, 'Jenkinsfile'))
app.save()
def other = j.getItem('other') ?: j.createProject(WorkflowJob, 'other')
other.setDefinition(new CpsFlowDefinition("echo 'x'", true))
other.save()
