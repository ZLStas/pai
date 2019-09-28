// MIT License
//
// Copyright (c) Microsoft Corporation. All rights reserved.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE

package algorithm

import (
	"fmt"
	"github.com/microsoft/hivedscheduler/pkg/api"
	"k8s.io/klog"
	"strings"
)

type (
	CellChain    string // name of a cell chain (type of the top-level cell)
	CellLevel    int32  // starts from 1
	CellPriority int32
)

type schedulingRequest struct {
	vc            api.VirtualClusterName
	reservationId api.ReservationId
	chain         CellChain
	podGpuNumbers map[int32]int32
	priority      CellPriority
}

type CellRequest struct {
	VC            api.VirtualClusterName
	ReservationId api.ReservationId
	Chain         CellChain
	Level         CellLevel
	Priority      CellPriority
}

// CellList is a list of cells at a certain level of a chain.
type CellList []Cell

func (cl CellList) String() string {
	names := make([]string, len(cl))
	for i, c := range cl {
		if cc, ok := c.(*PhysicalCell); ok {
			names[i] = fmt.Sprintf("%v(%v)(%v)", cc.GetName(), cc.GetPriority(), cc.GetPhysicalPlacementString())
		} else {
			names[i] = fmt.Sprintf("%v(%v)", c.GetName(), c.GetPriority())
		}
	}
	return strings.Join(names, ", ")
}

func (cl CellList) removeCell(c Cell) CellList {
	index := -1
	for i, cc := range cl {
		if cc == c {
			index = i
			break
		}
	}
	if index < 0 {
		panic(fmt.Sprintf("Cell not not found in list when removing: %v",
			c.GetName()))
	}
	length := len(cl)
	cl[index] = cl[length-1]
	cl[length-1] = nil
	return cl[:length-1]
}

func (cl CellList) Len() int {
	return len(cl)
}

func (cl CellList) Less(i int, j int) bool {
	if cl[i].GetUsedGpuNumSamePriority() > cl[j].GetUsedGpuNumSamePriority() {
		return true
	} else if cl[i].GetUsedGpuNumSamePriority() < cl[j].GetUsedGpuNumSamePriority() {
		return false
	} else if cl[i].GetUsedGpuNumOtherPriority() < cl[j].GetUsedGpuNumOtherPriority() {
		return true
	} else {
		return false
	}
}

func (cl CellList) Swap(i int, j int) {
	cl[i], cl[j] = cl[j], cl[i]
}

// ChainCellList maps each level in a chain to a CellList.
type ChainCellList map[CellLevel]CellList

func NewChainCellList(top CellLevel) ChainCellList {
	ccl := ChainCellList{}
	for i := CellLevel(1); i <= top; i++ {
		ccl[i] = CellList{}
	}
	return ccl
}

func (ccl ChainCellList) String() string {
	str := ""
	for i := 1; i <= len(ccl); i++ {
		str += fmt.Sprintf("level %v: %v\n", i, ccl[CellLevel(i)])
	}
	return str
}

func (ccl ChainCellList) removeCell(c Cell, l CellLevel) {
	ccl[l] = ccl[l].removeCell(c)
	klog.Infof("Cell removed from cell list: %v", c.GetName())
}

type AlgoAffinityGroup struct {
	cell                 *PhysicalCell
	unallocatedPodNums   map[int32]int32 // GpuNum -> PodNum
	physicalGpuPlacement map[int32][]CellList
	vcGpuPlacement       map[int32][]CellList
}

func newAlgoAffinityGroup(g *api.AffinityGroup) *AlgoAffinityGroup {
	numPods := make(map[int32]int32)
	for _, m := range g.Members {
		numPods[m.GpuNumber] += m.PodNumber
	}
	return &AlgoAffinityGroup{
		unallocatedPodNums: numPods,
		physicalGpuPlacement: map[int32][]CellList{},
		vcGpuPlacement: map[int32][]CellList{},
	}
}
