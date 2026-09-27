import { MetadataProvider } from '@stump/graphql'

export const PROVIDER_LABELS: Record<MetadataProvider, string> = {
	[MetadataProvider.Hardcover]: 'Hardcover',
	[MetadataProvider.ComicVine]: 'Comic Vine',
	[MetadataProvider.Lemon_64]: 'Lemon64',
	[MetadataProvider.WorldOfSpectrum]: 'World of Spectrum',
	[MetadataProvider.LemonAmiga]: 'Lemon Amiga',
	[MetadataProvider.Wikipedia]: 'Wikipedia',
}

export const PROVIDERS = Object.values(MetadataProvider)
