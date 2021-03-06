import React, {useCallback, useEffect, useRef, useState} from "react";
import { useConnection, TokenIcon, useConnectionConfig, MintParser, cache, TokenAccountParser, getMultipleAccounts, ParsedAccount} from "@oyster/common";
import {WORMHOLE_PROGRAM_ID} from "../utils/ids";
import BN from "bn.js";
import {ASSET_CHAIN, getAssetAmountInUSD, getAssetName, getAssetTokenSymbol} from "../utils/assets";
import { useEthereum } from "../contexts";
import { ParsedAccountData, PublicKey } from "@solana/web3.js";
import { models } from "@oyster/common";
import { AccountLayout, MintInfo, MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { BridgeLayout, GuardianSetLayout, WrappedMetaLayout, TransferOutProposalLayout } from './../models/bridge';
import { AssetMeta } from "../core";
import { TokenInfo } from "@solana/spl-token-registry";
import bs58 from "bs58";
import ErrorBoundary from "antd/lib/alert/ErrorBoundary";
import { COINGECKO_COIN_PRICE_API, COINGECKO_POOL_INTERVAL, useCoingecko } from "../contexts/coingecko";

const ParsedDataLayout = models.ParsedDataLayout

const getConfigKey = async () => {
  // @ts-ignore
  return (
    await PublicKey.findProgramAddress(
      [Buffer.from('bridge')],
      WORMHOLE_PROGRAM_ID,
    )
  )[0];
}
const getWrappedAssetMint = async (configKey: PublicKey, asset: AssetMeta) => {
  if (asset.chain === 1) {
    return new PublicKey(asset.address);
  }

  let seeds: Array<Buffer> = [
    Buffer.from('wrapped'),
    configKey.toBuffer(),
    Buffer.of(asset.chain),
    Buffer.of(asset.decimals),
    padBuffer(asset.address, 32),
  ];
  // @ts-ignore
  return (
    await PublicKey.findProgramAddress(seeds, WORMHOLE_PROGRAM_ID)
  )[0];
}

const getWrappedAssetMeta = async (configKey: PublicKey, mint: PublicKey) => {
  let seeds: Array<Buffer> = [
    Buffer.from('meta'),
    configKey.toBuffer(),
    mint.toBuffer(),
  ];
  // @ts-ignore
  return (
    await PublicKey.findProgramAddress(seeds, WORMHOLE_PROGRAM_ID)
  )[0];
}

function padBuffer(b: Buffer, len: number): Buffer {
  const zeroPad = Buffer.alloc(len);
  b.copy(zeroPad, len - b.length);
  return zeroPad;
}

type WrappedAssetMeta = { chain: number, decimals: number, address: string, mintKey: string, mint?: ParsedAccount<MintInfo>, amount: number, amountInUSD: number, logo?: string, symbol?: string };

export const useWormholeAccounts = () => {
  const connection = useConnection();
  const { tokenMap: ethTokens } = useEthereum();
  const {coinList} = useCoingecko();
  const {tokenMap: solanaTokens} = useConnectionConfig();

  const [lockedSolanaAccounts, setLockedSolanaAccounts] = useState<models.ParsedDataAccount[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  const [externalAssets, setExternalAssets] = useState<WrappedAssetMeta[]>([]);
  const [amountInUSD, setAmountInUSD] = useState<number>(0);

  /// TODO:
  /// assets that left Solana
  // 1. getTokenAccountsByOwner with bridge PDA
  // 2. get prices from serum ?
  // 3. multiply account balances by

  /// assets locked from ETH
  // 1. get asset address from proposal [x]
  // 2. find the asset in the coingecko list or call abi? []
  // 3. build mint address using PDA [x]
  // 4. query all mints [x]
  // 5. multiply mint supply by asset price from coingecko
  // 6. aggregate all assets
  // 7. subscribe to program accounts
  useEffect(() => {
    const queryTxs = async () => {
      setLoading(true);

      // authority -> query for token accounts to get locked assets
      let configKey = await getConfigKey();

      const filters = [
        {
          dataSize: TransferOutProposalLayout.span,
        },
        // {
        //   memcmp: {
        //     offset: TransferOutProposalLayout.offsetOf('assetChain'),
        //     bytes: 2,
        //   },
        // },
      ];

      let resp = await (connection as any)._rpcRequest('getProgramAccounts', [
        WORMHOLE_PROGRAM_ID.toBase58(),
        {
          commitment: connection.commitment,
          filters,
        },
      ]);


      const assets = new Map<string, WrappedAssetMeta>();
      const assetsByMint = new Map<string, WrappedAssetMeta>();

      // aggregate all assets that are not from Solana
      resp.result.map((acc: any) => ({
        publicKey: new PublicKey(acc.pubkey),
        account: {
          data: bs58.decode(acc.account.data),
          executable: acc.account.executable,
          owner: new PublicKey(acc.account.owner),
          lamports: acc.account.lamports,
        },
      })).map((acc: any) => {
        if(acc.account.data.length === TransferOutProposalLayout.span) {
          const parsedAccount = TransferOutProposalLayout.decode(acc.account.data)
          if (parsedAccount.assetChain !== ASSET_CHAIN.Solana) {
            const assetAddress: string = new Buffer(parsedAccount.assetAddress.slice(12)).toString("hex");
            if(!assets.has(assetAddress)) {
              assets.set(assetAddress, {
                chain: parsedAccount.assetChain,
                address: assetAddress,
                decimals: parsedAccount.assetDecimals,
                mintKey: '',
                amount: 0,
                amountInUSD: 0,
              });
            }
          }
        }
      });

      // build PDAs for mints
      await Promise.all([...assets.keys()].map(async key => {
        const meta = assets.get(key);
        if(!meta) {
          throw new Error('missing key');
        }

        meta.mintKey = (await getWrappedAssetMint(configKey, {
          chain: meta.chain,
          address: new Buffer(meta.address, "hex"),
          decimals: Math.min(meta.decimals, 9)
        })).toBase58();

        assetsByMint.set(meta.mintKey, meta);

        return meta;
      }));

      // query for all mints
      const mints = await getMultipleAccounts(connection, [...assetsByMint.keys()], 'singleGossip');

      // cache mints and listen for changes
      mints.keys.forEach((key, index) => {
        const asset = assetsByMint.get(key);
        if(!asset) {
          throw new Error('missing mint');
        }

        if(!mints.array[index]) {
          debugger;
        }

        cache.add(key, mints.array[index], MintParser);
        asset.mint = cache.get(key);
        asset.amount = asset.mint?.info.supply.toNumber() || 0;

        if(!asset.mint) {
          throw new Error('missing mint')
        }

        // monitor updates for mints
        connection.onAccountChange(asset.mint?.pubkey, (acc) => {
          cache.add(key, acc);
          asset.mint = cache.get(key);
          asset.amount = asset.mint?.info.supply.toNumber() || 0;

          setExternalAssets([...assets.values()]);
        });

        setExternalAssets([...assets.values()]);
      });

      setLoading(false);
    };

    queryTxs();
  }, [connection, setExternalAssets]);

  const coingeckoTimer = useRef<number>(0);
  const dataSourcePriceQuery = useCallback(async () => {
    if(externalAssets.length === 0) {
      return;
    }

    const addressToId = new Map<string, string>();
    const idToAsset = new Map<string, WrappedAssetMeta>();

    const ids = externalAssets.map(asset => {

      let token = ethTokens.get(`0x${asset.address || ''}`);
      if(!token) {
        return;
      }

      asset.logo = token.logoURI;
      asset.symbol = token.symbol;

      let coinInfo = coinList.get(token.symbol.toLowerCase());



      if(coinInfo) {
        idToAsset.set(coinInfo.id, asset);
        addressToId.set(asset.address, coinInfo.id);
        return coinInfo.id;
      }
    }).filter(_ => _);

    if(ids.length === 0) {
      return;
    }

    const parameters = `?ids=${ids.join(',')}&vs_currencies=usd`;
    const resp = await window.fetch(COINGECKO_COIN_PRICE_API+parameters);
    const data = await resp.json();

    let totalInUSD = 0;
    debugger;

    Object.keys(data).forEach(key => {
      let asset = idToAsset.get(key);
      if(!asset) {
        return;
      }

      asset.amountInUSD = asset.amount * (data[key]?.usd || 1);
      totalInUSD += asset.amountInUSD;
    });

    setAmountInUSD(totalInUSD);

    coingeckoTimer.current = window.setTimeout(
      () => dataSourcePriceQuery(),
      COINGECKO_POOL_INTERVAL
    );
  }, [externalAssets, setAmountInUSD])
  useEffect(() => {
    if (externalAssets && coinList) {
      dataSourcePriceQuery();
    }
    return () => {
      window.clearTimeout(coingeckoTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalAssets, coinList, dataSourcePriceQuery]);

  return {
    loading,
    externalAssets,
    totalInUSD: amountInUSD,
  };
}