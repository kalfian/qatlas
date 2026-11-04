//go:build unix

package worker

import (
	"os/exec"
	"syscall"
)

// setProcAttrs puts the runner in its own process group so browsers it spawned can be
// signalled together, and (on Linux) kills it if the worker dies.
func setProcAttrs(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	setParentDeathSignal(cmd.SysProcAttr)
}

// terminateProcess asks the runner to cancel in-flight runs and exit (SIGTERM).
func terminateProcess(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = syscall.Kill(cmd.Process.Pid, syscall.SIGTERM)
	}
}

// killProcess kills the runner's whole process group (runner + browsers).
func killProcess(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Process.Kill()
	}
}
