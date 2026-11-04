//go:build unix && !linux

package worker

import "syscall"

func setParentDeathSignal(*syscall.SysProcAttr) {}
