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

## check time left with slurm

``` bash
squeue -u $USER -O jobid,state,timeused,timelimit,timeleft,nodelist
```