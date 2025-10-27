# Ray Multi-Node Debugging Guide

## Current Issue (Job 5248953)

vLLM failing with: `Failed to connect to GCS at address 10.21.30.87:6379`

### Diagnostic Steps

1. **Check Ray head startup:**
```bash
cat logs/5248953/ray-head.log
```
Look for:
- Errors during Ray head startup
- Confirmation that GCS server started on port 6379
- Any network binding errors

2. **Verify port allocation:**
```bash
cat logs/5248953/port-allocation.log
cat logs/5248953/ray-head-ports.log
```
Check if Ray actually bound to the expected ports.

3. **Check Ray worker connectivity:**
```bash
cat logs/5248953/ray-worker-*.log
```
Look for connection attempts and failures.

4. **Verify head node IP resolution:**
```bash
grep "ray head ip:" forska-stack-5248953.log
grep "resolved HEAD_IP" forska-stack-5248953.log
```
Ensure the IP is reachable from all nodes.

5. **Test network connectivity (if job is still running):**
```bash
# From a worker node:
srun --nodes=1 --ntasks=1 --nodelist=<worker_node> \
  bash -c "nc -zv 10.21.30.87 6379"
```

### Common Issues

**Issue 1: HEAD_IP resolves to wrong interface**
- **Symptom:** Ray head starts but workers can't connect
- **Fix:** Override HEAD_IP when submitting:
  ```bash
  sbatch --export=ALL,HEAD_IP=<correct_ip> forska-stack.sbatch
  ```
- Find correct IP: `hostname -I` and pick the one on your cluster's main network

**Issue 2: Firewall blocking Ray ports**
- **Symptom:** Ray head starts, workers timeout
- **Fix:** Ensure ports 6379, 8265, and worker range (8888-9200) are open
- Check: `ss -ltn | grep 6379`

**Issue 3: Ray head didn't start**
- **Symptom:** No listening ports in ray-head-ports.log
- **Fix:** Check ray-head.log for errors, often related to:
  - CUDA/GPU issues
  - Missing dependencies
  - Insufficient permissions

**Issue 4: Slurm node name vs network hostname mismatch**
- **Symptom:** DNS resolution fails for head node
- **Fix:** Use IP address directly:
  ```bash
  # Get IP on head node first:
  HEAD_IP=$(hostname -I | awk '{print $1}')
  sbatch --export=ALL,HEAD_IP=$HEAD_IP forska-stack.sbatch
  ```

### What the Updated Script Does

The updated `forska-stack.sbatch` now:

1. **Tests HEAD_IP reachability** before starting Ray (line ~298)
   - Pings HEAD_IP to ensure it's reachable
   - Warns if not pingable

2. **Verifies Ray cluster health** before starting vLLM (line ~562)
   - Runs `ray status` to confirm cluster is ready
   - Waits up to 60 seconds for cluster to be healthy
   - Exits with clear error message if cluster unhealthy

3. **Better logging:**
   - Shows resolved HEAD_IP clearly
   - More detailed Ray head startup info
   - Diagnostic output on failures

### Next Steps for Current Job

1. Cancel the current job: `scancel 5248953`
2. Review the logs as described above
3. Identify the root cause (likely HEAD_IP issue)
4. Resubmit with fixes:
   ```bash
   # Option 1: Let script auto-detect (if network is correct)
   sbatch forska-stack.sbatch

   # Option 2: Override HEAD_IP if auto-detection wrong
   sbatch --export=ALL,HEAD_IP=<correct_cluster_ip> forska-stack.sbatch
   ```

### Preventing Future Issues

For Alvis cluster specifically, you may need to:
1. Set `NCCL_SOCKET_IFNAME` to the correct interface (e.g., `ib0` for InfiniBand)
2. Ensure you're using the correct IP subnet for inter-node communication
3. Check with cluster admins about firewall rules

Example for Alvis:
```bash
sbatch --export=ALL,NCCL_SOCKET_IFNAME=ib0 forska-stack.sbatch
```

