"use client";

import { useCallback, useMemo } from "react";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { useAppChain } from "@/lib/chain-context";
import { REGISTRY_ABI } from "@/lib/contracts";
import { maskFromCategories, type CategoryCode } from "@/lib/types";

export function useRegistryAdmin() {
  const appChain = useAppChain();
  const { address } = useAccount();
  const { writeContractAsync, isPending } = useWriteContract();
  const { data: owner } = useReadContract({
    address: appChain.contracts.agentRegistry,
    abi: REGISTRY_ABI,
    functionName: "owner",
    chainId: appChain.chainId,
    query: { enabled: appChain.deployed },
  });

  const isOwner = Boolean(
    address && owner && address.toLowerCase() === (owner as string).toLowerCase()
  );

  const register = useCallback(
    async (input: {
      agent: `0x${string}`;
      name: string;
      categories: CategoryCode[];
      endpoint: string;
      description: string;
      website: string;
    }) => {
      const hash = await writeContractAsync({
        address: appChain.contracts.agentRegistry,
        chainId: appChain.chainId,
        abi: REGISTRY_ABI,
        functionName: "registerAgent",
        args: [
          input.agent,
          input.name,
          maskFromCategories(input.categories),
          input.endpoint,
          input.description,
          input.website,
        ],
      });
      return hash;
    },
    [appChain.chainId, appChain.contracts.agentRegistry, writeContractAsync]
  );

  const setActive = useCallback(
    async (agent: `0x${string}`, active: boolean) => {
      return writeContractAsync({
        address: appChain.contracts.agentRegistry,
        chainId: appChain.chainId,
        abi: REGISTRY_ABI,
        functionName: "setActive",
        args: [agent, active],
      });
    },
    [appChain.chainId, appChain.contracts.agentRegistry, writeContractAsync]
  );

  return useMemo(
    () => ({ address, owner: owner as `0x${string}` | undefined, isOwner, isPending, register, setActive }),
    [address, isOwner, isPending, owner, register, setActive]
  );
}
