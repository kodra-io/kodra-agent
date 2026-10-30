"""Dev helper: the AWS CLI commands that only read, for the AWS connector's call_aws (B4).

Run with the Python of a venv that has the pinned awslabs.aws-api-mcp-server installed (its
lockfile is docker/mcp/pypi/awslabs.aws-api-mcp-server.txt):

    <venv python> scripts/aws-read-operations.py > src/aws/read-operations.json

An operation is a read when the server's own metadata calls it ReadOnly, minus the overrides
the server applies (credential calls like sts assume-role). Keys are the CLI's service and
command names, as the model writes them: {"ec2": ["describe-instances", ...], ...}.
"""

import importlib.resources
import json
import sys

from awscli.clidriver import create_clidriver
from awslabs.aws_api_mcp_server.core.metadata.read_only_operations_list import OVERRIDES

metadata = json.loads(
    importlib.resources.files('awslabs.aws_api_mcp_server.core')
    .joinpath('data/api_metadata.json')
    .read_text()
)

driver = create_clidriver()
reads: dict[str, list[str]] = {}
for cli_name, command in sorted(driver._get_command_table().items()):
    service_model = getattr(command, 'service_model', None)
    if service_model is None:
        continue  # a customization like `aws s3` or `aws configure`, classified by hand
    sdk_name = service_model.service_name
    known = metadata.get(sdk_name, {})
    ops = []
    for op_name, op_command in sorted(command._get_command_table().items()):
        model = getattr(op_command, '_operation_model', None)
        if model is None:
            continue
        if OVERRIDES.get(sdk_name, {}).get(model.name) is False:
            continue
        if known.get(model.name, {}).get('type') == 'ReadOnly':
            ops.append(op_name)
    if ops:
        reads[cli_name] = ops

json.dump(reads, sys.stdout, indent=0, sort_keys=True)
sys.stdout.write('\n')
