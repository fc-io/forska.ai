## how to list all running containers when using apptainer?

``` bash
apptainer instance list
# or
apptainer instance ls
apptainer instance list $USER # explicit
```

Apptainer doesn’t have a daemon like Docker – containers are just regular user processes.

The only things Apptainer itself can “see” and manage are instances (containers started with apptainer instance start ...).

If you run
apptainer shell image.sif
apptainer exec image.sif ...

those are just processes and won’t appear in instance list. To see those, you’d use normal process tools, e.g.:

``` bash
ps aux | grep apptainer
```

## check space used/left on Alvis

``` bash
C3SE_quota
```

## check time left with slurm

``` bash
squeue -u $USER -O jobid,state,timeused,timelimit,timeleft,nodelist
```

## how to run nvidia-smi for a node sbatch job
``` bash
 srun --jobid=2617 -N1 -n1 nvidia-smi
 ```

## projinfo on discoverer

``` bash
accountcheck ehpc-aif-2025pg01-233
```

``` bash
scontrol show job 2822 | egrep 'Account=|QOS=|TRES=|TimeLimit=|Reason='
```

``` bash
sacctmgr show association where user=fcarlsson account=ehpc-aif-2025pg01-233 format=Cluster,Account,User,QOS,GrpTRES,GrpTRESMins,GrpTRESRunMins%30
```

``` bash
module load accountcheck
accountcheck --all-accounts
```

## check storage quota

``` bash
C3SE_quota
```

## check partitions available
``` bash
[user@glogin1 ~]$ bsc_queues

>>>>>>>>>>>>>>>>>>> ACCOUNT: ehpc482 <<<<<<<<<<<<<<<<<<<<
     QUEUE NAME        MAX TIME   MAX PROC   DESCRIPTION
      acc_debug        02:00:00        640   Debug jobs with limitations in number of jobs running, time and number of nodes used for Accelerated GPU partition of MN5
       acc_ehpc (D)  3-00:00:00       8000   Standard EuroHPC projects for Accelerated GPU partition of MN5
acc_interactive        02:00:00         40   Interactive jobs in Accelerated GPU partition of MN5, only login nodes
```