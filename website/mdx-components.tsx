import type { MDXComponents } from 'mdx/types'
import { ResearchFigure } from './components/ResearchFigure'
export function useMDXComponents(components: MDXComponents): MDXComponents {
  // Headings are indexed in the typed manifest and attached by the article renderer.
  return { ResearchFigure, ...components }
}
