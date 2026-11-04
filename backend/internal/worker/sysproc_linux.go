//go:build linux

package worker

import "syscall"

// setParentDeathSignal makes the kernel SIGTERM the runner when the worker dies. Linux
// ties Pdeathsig to the forking OS thread; the Go runtime does not retire threads unless
// a goroutine exits while locked to one, which this code never does.
func setParentDeathSignal(a *syscall.SysProcAttr) { a.Pdeathsig = syscall.SIGTERM }
