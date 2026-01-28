# MN5 Slurm (ACC)

Purpose: quick reference for partitions + QoS relevant to the ACC side on MareNostrum 5.

Note: access is per-user/per-project. Always check your current Slurm association and live config.

## Quick checks

```bash
# What QoS you are allowed to use
ssh glog "sacctmgr show assoc user=\$USER format=User,Account,Partition,QOS -P"

# QoS limits (walltime, per-user caps, resource caps)
ssh glog "sacctmgr show qos format=Name,Priority,Flags,MaxWall,MaxJobsPU,MaxSubmitPU,MaxTRES,MinTRES -P"

# What QoS are rejected by a partition
ssh glog "scontrol show partition acc | grep -o 'DenyQos=.*'"
ssh glog "scontrol show partition accinteractive | grep -o 'DenyQos=.*'"
```

## Partitions

### acc

- Batch jobs on ACC compute nodes.
- Rejects interactive QoS: `acc_interactive`.

Typical sbatch headers:

```bash
#SBATCH --partition=acc
#SBATCH --qos=acc_ehpc
```

### accinteractive

- Interactive/login-like ACC partition (node: `alogin3`).
- Intended QoS: `acc_interactive`.

Example interactive allocation:

```bash
srun --partition=accinteractive --qos=acc_interactive --gres=gpu:1 --cpus-per-task=10 --time=02:00:00 --pty bash
```

## QoS for --partition=acc

These QoS exist on MN5; you can only use the ones your user/account is associated with.

| QoS            |     MaxWall | MaxJobsPU | MaxSubmitPU | Notes                           |
| -------------- | ----------: | --------: | ----------: | ------------------------------- |
| `acc_ehpc`     |  3-00:00:00 |         - |         366 | good default for most runs      |
| `acc_debug`    |    02:00:00 |         1 |         366 | fast turnaround, short walltime |
| `acc_xlong`    | 10-00:00:00 |         3 |         366 | long walltime                   |
| `acc_xlarge`   |  3-00:00:00 |         5 |         366 | larger per-user concurrency cap |
| `acc_xehpc`    |  3-00:00:00 |         3 |         366 | extended ehpc variant           |
| `acc_training` |  2-00:00:00 |         - |         366 | training-oriented queue         |
| `acc_resa`     |  3-00:00:00 |         - |         366 | reservation pool A              |
| `acc_resb`     |  2-00:00:00 |         - |         366 | reservation pool B              |
| `acc_resc`     |  1-00:00:00 |         - |         366 | reservation pool C              |
| `acc_bscls`    |  2-00:00:00 |         - |         366 | BSC pool                        |
| `acc_bsces`    |  2-00:00:00 |         - |         366 | BSC pool                        |
| `acc_bsccs`    |  2-00:00:00 |         - |         366 | BSC pool                        |
| `acc_bsccase`  |  2-00:00:00 |         - |         366 | BSC pool                        |
| `acc_xgc`      |  1-00:00:00 |         1 |           4 | strict submit cap               |
| `acc_ehpcb`    |  1-00:00:00 |         - |         366 | ehpc batch variant              |
| `acc_bench`    |           - |         - |           - | special (OverPartQOS)           |

## Common error

- `sbatch: error: Batch job submission failed: Invalid qos specification`
  - You are not allowed to use that QoS (assoc), or the QoS is incompatible with the partition.
  - Fix: pick a QoS from your assoc and ensure it matches the partition (`acc` vs `accinteractive`).
