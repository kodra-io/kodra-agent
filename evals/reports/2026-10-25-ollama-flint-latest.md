# Evaluation: ollama / flint:latest

Run on 2026-10-25 at 05:12 UTC, kodra-agent 0.3.10 (`e2f0c8e`).
Model id: `flint:latest` through `ollama`. Investigations are read-only. Checks are deterministic: no model grades the answers.
This model has no price in its manifest, so cost is unknown.

**9 of 10 passed.** Right root cause in 10 of 10; 76 tool calls; 231170 in, 17404 out tokens; cost unknown; 553 s.

| Scenario | Result | Root cause | Steps | Tokens | Cost | Time |
| --- | --- | --- | --- | --- | --- | --- |
| bad-image-tag | fail | right | 3 | 8543 in, 752 out | unknown | 25 s |
| crashloop | pass | right | 8 | 23101 in, 2359 out | unknown | 71 s |
| missing-configmap-key | pass | right | 17 | 51502 in, 2834 out | unknown | 85 s |
| missing-env | pass | right | 8 | 25861 in, 1509 out | unknown | 51 s |
| oomkilled | pass | right | 6 | 16008 in, 2212 out | unknown | 66 s |
| pvc-pending | pass | right | 3 | 7314 in, 792 out | unknown | 22 s |
| readiness-probe | pass | right | 6 | 12285 in, 893 out | unknown | 33 s |
| release-500s | pass | right | 10 | 38844 in, 3411 out | unknown | 111 s |
| service-no-endpoints | pass | right | 3 | 7903 in, 642 out | unknown | 21 s |
| unschedulable | pass | right | 12 | 39809 in, 2000 out | unknown | 69 s |

## Details

### bad-image-tag: An image tag that does not exist

- Found: the image cannot be pulled ("ImagePullBackOff")
- Found: the tag does not exist ("1.99.99")
- Must not: an unpinned latest tag trades one problem for another. said: `busybox:1.36.1` or `busybox:latest`, then let the Deployment roll out the new replica.

> **What's wrong:** The `api` container in the `search-api` Deployment is configured to pull the image **`busybox:1.99.99-does-not-exist`**, which is not a valid, existing image tag: ``` image: busybox:1.99.99-does-not-exist imagePullPolicy: IfNotPresent ``` The pod event confirms it: the kubelet tried to pull the image, failed with `failed to resolve reference "docker.io/library/busybox:1.99.99-does-not-exist": not found`, and went into `ImagePullBackOff`, so the pod never became ready and the Deployment is stuck at `0/1` ready with `MinimumReplicasUnavailable`. **Why it never starts:** The Deployment itself is fine (it scaled the pod up, scheduling worked, container command is valid). The failure is purely at the image pull step — the pod is pending on a nonexistent image reference, so it can never reach readiness. **Suggested fix:** Update the container image in the Deployment spec to a valid image tag, e.g. `busybox:1.36.1` or `busybox:latest`, then let the Deployment roll out the new replica. Would you like me to make this change (e.g., update the image to a valid tag via the Deployment spec)? If you have a preferred image/version in mind, tell me, otherwise I can set it to a kn

### crashloop: A service that cannot reach its database

- Found: the database it connects to ("db:5432")
- Found: the connection is refused ("connection refused")

> # Investigation Report: KubePodCrashLooping (orders-api) ## What is wrong The `orders-api` deployment in the `crashloop` namespace is running a **placeholder/BusyBox command** instead of the real application. The container immediately exits with code 1, causing an endless crash loop. The failure is *not* an infrastructure fault — the app itself is misconfigured at the Deployment level. **Root cause:** The container image (`busybox:1.37`) with the command: ``` sh -c 'echo Error: cannot connect to database at db:5432: connection refused; sleep 5; exit 1' ``` This is a self-contained test script that tries to reach a database host named `db` on port 5432, which doesn't exist as a reachable service in this deployment, then exits. ## Evidence **1. Pod status — container in Error state with restarts (crashloop):** ``` NAMESPACE APIVERSION KIND NAME READY STATUS RESTARTS AGE crashloop v1 Pod orders-api-d7546786-vtzxj 0/1 Error 3 (39s ago) 74s ``` **2. Pod spec (`kubernetes__pods_get`)** — the container command and image: ```yaml containers: - command: - sh - -c - 'echo ''Error: cannot connect to database at db:5432: connection refused''; sleep 5; exit 1' image: busybox:1.37 name: app ... 

### missing-configmap-key: A ConfigMap without the key a container needs

- Found: the container config is broken ("CreateContainerConfigError")
- Found: the missing key ("SMTP_HOST")
- 2 tool call(s) blocked by policy.

> **What's wrong:** The pod `notifier-867d7c7f46-p7rqp` in namespace `missing-configmap-key` is stuck in `CreateContainerConfigError` — it never even gets to run the container command. The cause (from the pod event): ``` Error: couldn't find key SMTP_HOST in ConfigMap missing-configmap-key/notifier-config ``` The pod's container is configured with an environment variable that pulls its value from a ConfigMap: ```yaml env: - name: SMTP_HOST valueFrom: configMapKeyRef: key: SMTP_HOST name: notifier-config ``` …but the `SMTP_HOST` key doesn't exist in the `notifier-config` ConfigMap, so the container runtime aborts startup with a `CreateContainerConfigError`. **Suggested fix:** - Add the missing `SMTP_HOST` key (with its value) to the `notifier-config` ConfigMap in namespace `missing-configmap-key`, or - Update the pod/deployment to point at an existing key / remove the env var if it's not actually needed. Note: I couldn't read the contents of the ConfigMap itself to verify the missing value, and the read was permission-restricted in this cluster — but the missing key is clearly what the pod error indicates is blocking startup. Would you like me to make the change (e.g., patch the deplo

### missing-env: A required environment variable is not set

- Found: the variable that is missing ("PAYMENT_API_URL")
- Found: it is not set ("not set")

> ## Diagnosis The `billing-worker` pod in `missing-env` is crash-looping due to a missing environment variable. **Evidence:** 1. **Pod status** (`billing-worker-5b5c6dbd-b6qwl`): `0/1` ready, `Error` status, restart count 5, currently in a **BackOff** loop. 2. **Container logs**: ``` fatal: required environment variable PAYMENT_API_URL is not set ``` 3. **Container command** (from both pod and Deployment spec): ```sh if [ -z "$PAYMENT_API_URL" ]; then echo 'fatal: required environment variable PAYMENT_API_URL is not set'; exit 1; fi; sleep 3600 ``` 4. **Pod spec**: The `worker` container defines **no `env` section at all** — no environment variables are injected, even though the container requires `PAYMENT_API_URL`. **Why it's restarting:** The container starts, immediately detects that `PAYMENT_API_URL` is unset, prints the fatal error, and exits with code 1. With `restartPolicy: Always`, the kubelet restarts it, it fails again, and you get the escalating BackOff pattern. ## Suggested fix Provide the `PAYMENT_API_URL` environment variable to the container — either: - Add it directly under `spec.containers[0].env` in the Deployment (e.g. from a `Secret` like `payment-api-url` via `v

### oomkilled: A container that runs out of memory

- Found: it was killed for using too much memory ("OOMKilled")
- Found: the memory limit ("32Mi")

> ## Investigation Report: KubeContainerOOMKilled ### What is wrong The `KubeContainerOOMKilled` alert fired for the `report-builder` deployment in the `oomkilled` namespace. The `builder` container was **OOMKilled (exit code 137)** and is now in a **CrashLoopBackOff** loop, keeping the deployment in a state of `MinimumReplicasUnavailable`. Root cause: the container's command is an infinite loop that never terminates: ``` sh -c "echo 'building monthly report'; tail /dev/zero" ``` `tail /dev/zero` reads from the infinite zero device indefinitely. Combined with a tight **32Mi memory limit**, the process consumes memory until the kernel kills it — the OOMKilled exit path. ### Evidence (read-only tool calls) 1. **Alert data** — `alertname: KubeContainerOOMKilled`, `namespace: oomkilled`, `deployment: report-builder`, starts at `2026-10-25T05:17:52Z`. 2. **Deployment** (`kubernetes__resources_get`, apps/v1 / Deployment / report-builder / oomkilled): - Container `builder`, image `busybox:1.37` - Command: `sh -c "echo 'building monthly report'; tail /dev/zero"` - `limits.memory: 32Mi`, `requests.memory: 32Mi` 3. **Pod state** (`kubernetes__pods_list_in_namespace` + `kubernetes__pods_get`): 

### pvc-pending: A volume claim with a storage class that does not exist

- Found: the volume claim is not bound ("PersistentVolumeClaim")
- Found: the storage class ("fast-ssd")

> The pod `ledger-8458f6dc4-ftfdv` is stuck in **Pending** because it can't be scheduled due to a volume problem: **Root cause:** - The pod spec requests a volume from a PersistentVolumeClaim named **`ledger-data`** (in the `pvc-pending` namespace). - The PVC failed to provision: the events show `storageclass.storage.k8s.io "fast-ssd" not found` (`ProvisioningFailed`). - Because no volume could be bound, the scheduler emitted: *"0/1 nodes are available: pod has unbound immediate PersistentVolumeClaims. not found"* So the pod never gets a node/IP because its PVC can never be bound — hence it stays in `Pending` forever (0/1). **Suggested fixes:** 1. **Create the missing StorageClass** named `fast-ssd`, e.g.: ```yaml apiVersion: storage.k8s.io/v1 kind: StorageClass metadata: name: fast-ssd provisioner: <your-csi-driver-or-gce/vsphere/etc.> parameters: {} ``` 2. Or update the deployment's pod spec to reference an existing StorageClass (e.g. the default one) / set `storageClassName` appropriately. I couldn't retrieve the PVC directly (the eval agent's RBAC is restricted), but the events confirm the storage class is missing and that's what blocks the pod.

### readiness-probe: A readiness probe that never passes

- Found: the readiness probe fails ("readiness")
- Found: what the probe checks ("/tmp/ready")

> **Why the cart deployment shows 0/1 ready:** The pod is `Running` and the container started fine, but the **readiness probe keeps failing**: ``` Readiness probe failed: cat: can't open '/tmp/ready': No such file or directory ``` The root cause is a mismatch between the probe and the container command: - **Readiness probe** (from the Deployment): runs `cat /tmp/ready` every 5s, expecting that file to exist. - **Container command** (from the Deployment spec): `sh -c "echo 'cart started, warming cache'; sleep 3600"` — it never creates `/tmp/ready`. Since `/tmp/ready` is never created, the probe fails 3 times in a row (failureThreshold: 3), the pod never becomes ready, and the Deployment reports `0/1` ready / `MinimumReplicasUnavailable`. **Suggested fix:** add a file creation to the startup command, e.g.: ```sh echo 'cart started, warming cache'; sleep 3600 & while [ ! -f /tmp/ready ]; do sleep 1; done ``` or simpler, have the command create the marker before sleeping: ```sh sh -c "echo 'cart started, warming cache'; touch /tmp/ready; sleep 3600" ``` Would you like me to apply this fix to the Deployment?

### release-500s: A new release that answers with errors

- Found: the requests fail with 500 ("500")
- Found: it started with the new release ("2.4.0")
- Found: the error in the code ("NullPointerException")

> ## Investigation Report: HighErrorRate (release-500s / orders) ### What is wrong The `orders` Deployment in `release-500s` is running a **stale/bogus container definition**: the pod's container command is a shell loop that deliberately returns HTTP 500 on `/api/orders`, instead of running the actual orders application. The Deployment controller (revision 2, change-cause `release 2.4.0`) and the owning ReplicaSet `orders-6564f4cc6b` both carry this same faulty command, so the broken workload keeps getting deployed and keeps serving 5xx responses — hence the **HighErrorRate** alert (critical, "More than 5% of requests ... return 5xx"). ### Evidence 1. **Deployment** (`apps/v1`, `Deployment/orders`, ns `release-500s`) — faulty spec: - `spec.containers[0].command`: ``` sh -c while true; do echo "$(date -u +%H:%M:%S) GET /api/orders 500 3ms release=$RELEASE error=NullPointerException at OrderService.total"; sleep 2; done ``` - Env `RELEASE=2.4.0`, image `busybox:1.37`, `imagePullPolicy: IfNotPresent` - Status: `availableReplicas: 1`, `readyReplicas: 1`, `replicas: 1` — i.e. the pod is considered *healthy* even though it's a fake error loop. 2. **ReplicaSet** `orders-6564f4cc6b` — contai

### service-no-endpoints: A Service whose selector matches no pods

- Found: the Service selector does not match the pods ("selector")
- Found: the label that differs ("checkout-v2")

> **Root cause found: a Service selector mismatch.** - The Service `checkout` in namespace `service-no-endpoints` has the selector `app=checkout`. - The Pod `checkout-699d6bb849-xghfg` is running fine (1/1, Ready, Running for ~8m30s) but its labels are `app=checkout-v2` and `pod-template-hash=699d6bb849`. Because the Service selector `app=checkout` doesn't match any pod labels, the Endpoints Controller never creates an Endpoints object for the Service, so it has no ready endpoints and in-cluster DNS / ClusterIP routing has nothing to route to. **Fix options:** 1. Change the Service selector to `app=checkout-v2`, or 2. Change the Pod labels to `app=checkout` (e.g. via the Deployment's template labels). Would you like me to apply one of these fixes (e.g., update the Service selector to `app=checkout-v2`)?

### unschedulable: A pod that asks for more CPU than any node has

- Found: no node has enough CPU ("Insufficient cpu")
- Found: the request is too large ("request")
- 3 tool call(s) blocked by policy.

> **Root cause: the pod requests far more CPU than the cluster has available.** The `batch-runner` pod `batch-runner-779c76f9b4-s89sd` is stuck in `Pending` because the scheduler can't find a node that fits its requests. Evidence: - **Pod status:** `Pending`, with a `PodScheduled` condition reporting `Unschedulable`. - **Scheduling event:** `FailedScheduling` → *"0/1 nodes are available: 1 Insufficient cpu. ... Preemption is not helpful for scheduling."* (Note: there's only 1 node in this cluster.) - **Pod spec:** the single container `runner` (busybox, `sleep 3600`) requests: - `cpu: "64"` → **64 CPU cores** - `memory: 64Mi` Since the whole cluster has essentially one node with limited allocatable CPU, a request for 64 cores can never be satisfied, so the scheduler keeps deferring it. The fix is to lower the CPU request in the Deployment/Pod spec (e.g., `cpu: "1"` or remove the `resources` block entirely, or set it to something like `cpu: "500m"`). The actual container only runs `sleep 3600`, so it doesn't need 64 cores. Would you like me to patch the Deployment to reduce the CPU request?
