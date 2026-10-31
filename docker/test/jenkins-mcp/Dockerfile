# A throwaway Jenkins with the official MCP Server plugin, for the plugin e2e test
# (apps/agent/src/jenkins-plugin.e2e.test.ts). Test only: a fixed password, no TLS.
# The plugin needs git and JUnit for its SCM and test-result tools.
FROM jenkins/jenkins:2.580.1-lts-jdk21@sha256:a660310e39ade10631f774bacd5219de767dfd08947ea5c32a739b5e5bb382c1
ENV JAVA_OPTS="-Djenkins.install.runSetupWizard=false"
RUN jenkins-plugin-cli --plugins \
  mcp-server:0.222.v9d40a_8d624e4 \
  workflow-job:1622.vc41c189cb_e5f \
  workflow-cps:4395.v738456a_5da_6b_ \
  workflow-basic-steps:1129.v60e3c7e6654d \
  git:5.11.0 \
  junit:1455.v5c1b_eed56292 \
  cloudbees-folder:6.1107.v31f8955765c8
# A user (kodra), a folder with one job (team-a/deploy-web), and a job outside it (other).
COPY init/ /usr/share/jenkins/ref/init.groovy.d/
