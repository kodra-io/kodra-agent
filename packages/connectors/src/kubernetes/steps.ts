import type { SetupStep } from '@kodra-agent/schema';

/**
 * How to make the agent's kubeconfig (M28): a service account of its own, a read-only Role in
 * each listed namespace, and a kubeconfig with that account's token. It works on any cluster,
 * EKS included, so the agent needs no cloud keys for Kubernetes.
 */

const TOKEN_SECRET = `apiVersion: v1
kind: Secret
metadata:
  name: kodra-agent-token
  annotations:
    kubernetes.io/service-account.name: kodra-agent
type: kubernetes.io/service-account-token`;

const READ =
  '--verb=get,list,watch --resource=pods,pods/log,events,deployments,replicasets,services';

const unix = {
  account: `kubectl create namespace kodra-agent
kubectl create serviceaccount kodra-agent -n kodra-agent
kubectl apply -n kodra-agent -f - <<'EOF'
${TOKEN_SECRET}
EOF`,
  roles: `for ns in {{namespaces}}; do
  kubectl create role kodra-agent-read -n "$ns" ${READ}
  kubectl create rolebinding kodra-agent-read -n "$ns" --role=kodra-agent-read --serviceaccount=kodra-agent:kodra-agent
done`,
  scale: `for ns in {{namespaces}}; do
  kubectl create role kodra-agent-scale -n "$ns" --verb=get,update --resource=deployments/scale
  kubectl create rolebinding kodra-agent-scale -n "$ns" --role=kodra-agent-scale --serviceaccount=kodra-agent:kodra-agent
done`,
  kubeconfig: `SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 --decode > kodra-ca.crt
TOKEN=$(kubectl get secret kodra-agent-token -n kodra-agent -o jsonpath='{.data.token}' | base64 --decode)
kubectl config set-cluster cluster --kubeconfig=kodra-kubeconfig --server="$SERVER" --certificate-authority=kodra-ca.crt --embed-certs=true
kubectl config set-credentials kodra-agent --kubeconfig=kodra-kubeconfig --token="$TOKEN"
kubectl config set-context kodra-agent --kubeconfig=kodra-kubeconfig --cluster=cluster --user=kodra-agent
kubectl config use-context kodra-agent --kubeconfig=kodra-kubeconfig
rm kodra-ca.crt`,
};

const windows = {
  account: `kubectl create namespace kodra-agent
kubectl create serviceaccount kodra-agent -n kodra-agent
@'
${TOKEN_SECRET}
'@ | kubectl apply -n kodra-agent -f -`,
  roles: `foreach ($ns in '{{namespaces}}'.Split(' ')) {
  kubectl create role kodra-agent-read -n $ns ${READ}
  kubectl create rolebinding kodra-agent-read -n $ns --role=kodra-agent-read --serviceaccount=kodra-agent:kodra-agent
}`,
  scale: `foreach ($ns in '{{namespaces}}'.Split(' ')) {
  kubectl create role kodra-agent-scale -n $ns --verb=get,update --resource=deployments/scale
  kubectl create rolebinding kodra-agent-scale -n $ns --role=kodra-agent-scale --serviceaccount=kodra-agent:kodra-agent
}`,
  kubeconfig: `$server = kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'
$ca = kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}'
[IO.File]::WriteAllBytes("$PWD\\kodra-ca.crt", [Convert]::FromBase64String($ca))
$token = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((kubectl get secret kodra-agent-token -n kodra-agent -o jsonpath='{.data.token}')))
kubectl config set-cluster cluster --kubeconfig=kodra-kubeconfig --server=$server --certificate-authority=kodra-ca.crt --embed-certs=true
kubectl config set-credentials kodra-agent --kubeconfig=kodra-kubeconfig --token=$token
kubectl config set-context kodra-agent --kubeconfig=kodra-kubeconfig --cluster=cluster --user=kodra-agent
kubectl config use-context kodra-agent --kubeconfig=kodra-kubeconfig
Remove-Item kodra-ca.crt`,
};

const both = (key: keyof typeof unix) => ({
  linux: unix[key],
  macos: unix[key],
  windows: windows[key],
});

export const KUBECONFIG_STEPS: SetupStep[] = [
  {
    text: 'On a machine where kubectl already reaches the cluster as an admin, give the agent a service account of its own, with a long-lived token.',
    run: both('account'),
  },
  {
    text: 'Let it read in your namespaces ({{namespaces}}) and nowhere else.',
    run: both('roles'),
  },
  {
    text: 'Only for write access: also let it scale deployments there.',
    run: both('scale'),
  },
  {
    text: 'Write a kubeconfig that signs in as that account. It works on EKS, AKS, and GKE too, without cloud keys.',
    run: both('kubeconfig'),
  },
  { text: 'Upload kodra-kubeconfig here. The agent tests it before saving it.' },
];

/** For a kubeconfig that runs `aws eks get-token`: an IAM user that can only view. */
export const EKS_KEY_STEPS: SetupStep[] = [
  {
    text: 'Only needed when your kubeconfig signs in with `aws eks get-token`. A kubeconfig made with the steps above needs no AWS keys.',
  },
  {
    text: 'Create an IAM user for the agent and its access key. Copy AccessKeyId and SecretAccessKey from the output; AWS shows the secret only once.',
    run: {
      all: `aws iam create-user --user-name kodra-agent-eks
aws iam create-access-key --user-name kodra-agent-eks`,
    },
  },
  {
    text: 'Let that user view your namespaces ({{namespaces}}) in the cluster, and nothing else. Use your cluster name and account id.',
    run: {
      all: `aws eks create-access-entry --cluster-name <cluster-name> --principal-arn arn:aws:iam::<account-id>:user/kodra-agent-eks
aws eks associate-access-policy --cluster-name <cluster-name> --principal-arn arn:aws:iam::<account-id>:user/kodra-agent-eks --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy --access-scope type=namespace,namespaces={{namespaces:comma}}`,
    },
  },
];
