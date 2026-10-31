import jenkins.model.*
import com.cloudbees.hudson.plugins.folder.Folder
import org.jenkinsci.plugins.workflow.job.WorkflowJob
import org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition
def j = Jenkins.get()
def folder = j.getItem('team-a') ?: j.createProject(Folder, 'team-a')
def job = folder.getItem('deploy-web') ?: folder.createProject(WorkflowJob, 'deploy-web')
job.setDefinition(new CpsFlowDefinition("node { echo 'hello' }", true))
job.save()
def other = j.getItem('other') ?: j.createProject(WorkflowJob, 'other')
other.setDefinition(new CpsFlowDefinition("echo 'x'", true))
other.save()
