import jenkins.model.*
import hudson.security.*
def j = Jenkins.get()
def realm = new HudsonPrivateSecurityRealm(false)
realm.createAccount('kodra', 'kodra-e2e-password') // gitleaks:allow (test-only Jenkins)
j.setSecurityRealm(realm)
def auth = new FullControlOnceLoggedInAuthorizationStrategy()
auth.setAllowAnonymousRead(false)
j.setAuthorizationStrategy(auth)
j.save()
