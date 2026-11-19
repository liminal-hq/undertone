# Throwaway spike R4: run a command, print wall time, CPU time, and the largest child's peak RSS.
import resource, subprocess, sys, time
t = time.time()
r = subprocess.run(sys.argv[1:])
w = time.time() - t
u = resource.getrusage(resource.RUSAGE_CHILDREN)
print(f"wall {w:.1f} s, user {u.ru_utime:.1f} s, sys {u.ru_stime:.1f} s, peak RSS of largest child {u.ru_maxrss/1024:.0f} MB", file=sys.stderr)
sys.exit(r.returncode)
