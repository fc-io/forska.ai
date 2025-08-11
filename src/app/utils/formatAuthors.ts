export const formatAuthors = (authors: string[] | null): string => {
  const authorList = authors || []

  if (authorList.length < 3) {
    return authorList.join(', ')
  }

  return `${authorList[0]}... ${authorList[authorList.length - 1]}`
}
