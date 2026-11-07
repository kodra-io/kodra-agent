# A throwaway Jenkins with the official MCP Server plugin, for the plugin e2e test
# (apps/agent/src/jenkins-plugin.e2e.test.ts). Test only: a fixed password, no TLS.
# The plugin needs git and JUnit for its SCM and test-result tools. Multibranch, declarative
# pipelines, and credentials binding run and validate the Jenkinsfile ship writes (B5).
FROM jenkins/jenkins:2.580.1-lts-jdk21@sha256:a660310e39ade10631f774bacd5219de767dfd08947ea5c32a739b5e5bb382c1
ENV JAVA_OPTS="-Djenkins.install.runSetupWizard=false"
RUN jenkins-plugin-cli --plugins \
  mcp-server:0.222.v9d40a_8d624e4 \
  workflow-job:1622.vc41c189cb_e5f \
  workflow-cps:4395.v738456a_5da_6b_ \
  workflow-basic-steps:1129.v60e3c7e6654d \
  git:5.11.0 \
  junit:1455.v5c1b_eed56292 \
  cloudbees-folder:6.1107.v31f8955765c8 \
  workflow-multibranch:842.v3a_b_59b_57b_e6e \
  workflow-durable-task-step:1479.v56e587f413a_7 \
  pipeline-model-definition:2.2293.v6e7193cec599 \
  credentials-binding:728.v902a_273b_8947
# A user (kodra), a folder with one job (team-a/deploy-web), and a job outside it (other).
COPY init/ /usr/share/jenkins/ref/init.groovy.d/
